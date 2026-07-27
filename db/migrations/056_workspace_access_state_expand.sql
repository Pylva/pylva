-- Remove-Free rollout, expand phase.
--
-- Commercial plan (`builders.tier`) is no longer an account lifecycle state.
-- This migration adds explicit access/provenance columns and backfills either
-- hosted billing state or self-hosted access. The legacy Free default remains
-- temporarily for old-binary schema compatibility, but a validated temporary
-- constraint makes every attempted legacy Free write fail closed.
-- The final paid-plan constraints are deferred to migration 058 so old and new
-- application versions can coexist while workers are drained. A validated
-- temporary constraint is installed immediately after the zero-Free preflight,
-- however, so a legacy writer can fail closed but can never recreate Free
-- during that compatibility window.

-- Migration 054 moved general application tables behind a fixed NOLOGIN owner.
-- The migration principal has an explicit SET-only edge to that owner.
SET ROLE pylva_general_app_runtime;

ALTER TABLE builders
  ADD COLUMN IF NOT EXISTS access_state VARCHAR(32),
  ADD COLUMN IF NOT EXISTS entitlement_source VARCHAR(32);

ALTER TABLE builders
  ALTER COLUMN tier DROP NOT NULL;

-- Migration 052 predated workspace lifecycle columns and therefore granted the
-- dedicated budget runtime table-wide SELECT on builders. Narrow that legacy
-- grant now that the complete authorization tuple is available. PostgreSQL
-- also requires UPDATE privilege for SELECT ... FOR SHARE/KEY SHARE; granting
-- UPDATE on the tenant key alone permits the lifecycle service to hold the
-- suspension-linearizing row lock without exposing any mutable entitlement or
-- customer-profile column. The builders RLS policy requires both the old and
-- new id to equal app.builder_id, so this role cannot move a row to another
-- tenant identity.
REVOKE ALL PRIVILEGES ON TABLE builders
  FROM pylva_budget_control_runtime;

-- Table-level REVOKE does not clear any historical column ACL drift. Reset
-- direct builder-column grants before installing the exact allowlist.
DO $budget_runtime_builder_column_acl_reset$
DECLARE
  grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT privilege.privilege_type,
           pg_catalog.string_agg(
             pg_catalog.format('%I', attribute.attname),
             ', ' ORDER BY attribute.attnum
           ) AS column_list
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE attribute.attrelid = 'public.builders'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND grantee.rolname = 'pylva_budget_control_runtime'
      AND privilege.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      )
    GROUP BY privilege.privilege_type
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE public.builders FROM pylva_budget_control_runtime',
      grant_row.privilege_type,
      grant_row.column_list
    );
  END LOOP;
END;
$budget_runtime_builder_column_acl_reset$;

GRANT SELECT (id, tier, access_state, entitlement_source)
  ON TABLE builders
  TO pylva_budget_control_runtime;
GRANT UPDATE (id)
  ON TABLE builders
  TO pylva_budget_control_runtime;

DO $$
DECLARE
  hosted_billing_present BOOLEAN :=
    to_regclass('public.builder_subscriptions') IS NOT NULL;
  legacy_free_count BIGINT;
  legacy_free_sample TEXT;
BEGIN
  SELECT count(*)
    INTO legacy_free_count
    FROM builders
    WHERE tier = 'free';

  IF legacy_free_count > 0 THEN
    SELECT string_agg(id::text, ', ' ORDER BY id::text)
      INTO legacy_free_sample
      FROM (
        SELECT id
        FROM builders
        WHERE tier = 'free'
        ORDER BY id
        LIMIT 20
      ) sample;

    RAISE EXCEPTION USING
      MESSAGE = format(
        'workspace access-state migration blocked: %s Free workspace(s) remain',
        legacy_free_count
      ),
      DETAIL = format(
        'Free workspace ids (up to 20): %s',
        COALESCE(legacy_free_sample, '(none)')
      ),
      HINT =
        'Run the read-only removal preflight and resolve every Free workspace before retrying.';
  END IF;

  IF hosted_billing_present THEN
    -- The private hosted companion migration owns subscription truth and the
    -- least-privilege cross-owner bridge needed to read it. This public
    -- migration deliberately does not query builder_subscriptions after
    -- assuming the general application owner role. Hosted rows remain
    -- lifecycle-null until companion migration 057 performs its zero-Free
    -- preflight and deterministic billing backfill in the same release.
    RAISE NOTICE
      'hosted billing catalog detected; deferring workspace lifecycle backfill to companion migration 057';
  ELSE
    -- The public distribution has no platform subscription table. Existing
    -- seed/operator paid labels were never Stripe entitlements, so convert
    -- every remaining workspace to explicit self-hosted access. Free rows were
    -- rejected above and are never converted implicitly.
    UPDATE builders
    SET tier = NULL,
        access_state = 'active',
        entitlement_source = 'self_hosted';
  END IF;
END
$$;

-- The legacy default remains visible to old binaries, but it is no longer a
-- valid write. Because the zero-Free preflight above and this constraint are in
-- the same ALTER-locked migration transaction, a concurrent legacy insert
-- either commits before the preflight and aborts this migration, or waits and
-- is rejected by this validated constraint after commit.
ALTER TABLE builders
  ADD CONSTRAINT builders_no_new_free_during_expand_check
    CHECK (tier IS DISTINCT FROM 'free') NOT VALID;

ALTER TABLE builders
  VALIDATE CONSTRAINT builders_no_new_free_during_expand_check;

ALTER TABLE builders
  ADD CONSTRAINT builders_access_state_value_check
    CHECK (
      access_state IS NULL
      OR access_state IN ('checkout_required', 'active', 'suspended')
    ) NOT VALID,
  ADD CONSTRAINT builders_entitlement_source_value_check
    CHECK (
      entitlement_source IS NULL
      OR entitlement_source IN ('stripe', 'enterprise_contract', 'self_hosted', 'admin')
    ) NOT VALID;

ALTER TABLE builders
  VALIDATE CONSTRAINT builders_access_state_value_check,
  VALIDATE CONSTRAINT builders_entitlement_source_value_check;

COMMENT ON COLUMN builders.tier IS
  'Nullable commercial plan: pro, scale, or enterprise. Physical name retained during API compatibility window.';
COMMENT ON COLUMN builders.access_state IS
  'Workspace lifecycle gate: checkout_required, active, or suspended.';
COMMENT ON COLUMN builders.entitlement_source IS
  'Authoritative entitlement provenance: stripe, enterprise_contract, self_hosted, admin, or null.';

RESET ROLE;
