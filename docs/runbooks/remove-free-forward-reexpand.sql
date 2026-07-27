-- REVIEWED OPERATOR TEMPLATE — NEVER AUTO-APPLIED.
-- migration-preflight: ok T8 This is an emergency widening migration applied only after 058/059 and before a lifecycle-aware dual-read binary; it restores no default and no pre-expand writer.
--
-- Forward hotfix that re-expands the contracted workspace-entitlement schema
-- before rolling back to the lifecycle-aware dual-read release. Use only after
-- migration 058/059 when restoring that release is unavoidable. Never edit an
-- applied migration or mark it unapplied.
--
-- This template does not restore the legacy Free default or any Free writer.
-- A pre-expand binary remains unsafe: an omitted tier now produces NULL, and
-- that binary does not populate lifecycle columns. The expanded combination
-- constraint deliberately rejects the ambiguous NULL/NULL/NULL tuple.
-- Only a lifecycle-aware dual-read binary may run against this contract.
--
-- Before execution:
--   1. stop request, worker, cron, and webhook traffic;
--   2. confirm the target binary is the lifecycle-aware dual-read release;
--   3. snapshot PostgreSQL and preserve the migration ledger;
--   4. turn this template into a newly numbered, reviewed forward migration;
--   5. apply it with the standard migration runner, which supplies the
--      transaction and migration-ledger record; and
--   6. run entitlement/source and zero-Free checks before resuming traffic.

-- Deliberately omit BEGIN/COMMIT: db:migrate wraps each file in sql.begin().
-- Embedded transaction control is rejected by migration-preflight and the
-- production runner.

SET LOCAL ROLE pylva_general_app_runtime;

ALTER TABLE builders
  ALTER COLUMN tier DROP DEFAULT,
  ALTER COLUMN access_state DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS builders_plan_check,
  DROP CONSTRAINT IF EXISTS builders_entitlement_combination_check;

ALTER TABLE builders
  ADD CONSTRAINT builders_plan_check
    CHECK (tier IS NULL OR tier IN ('pro', 'scale', 'enterprise')) NOT VALID,
  ADD CONSTRAINT builders_entitlement_combination_check
    CHECK ((
      (
        access_state = 'checkout_required'
        AND tier IS NULL
        AND entitlement_source IS NULL
      )
      OR
      (
        access_state = 'suspended'
        AND tier IS NULL
        AND (
          entitlement_source IS NULL
          OR entitlement_source IN ('stripe', 'admin')
        )
      )
      OR
      (
        access_state = 'active'
        AND tier IN ('pro', 'scale')
        AND entitlement_source IN ('stripe', 'admin')
      )
      OR
      (
        access_state = 'active'
        AND tier = 'enterprise'
        AND entitlement_source IN ('enterprise_contract', 'admin')
      )
      OR
      (
        access_state = 'active'
        AND tier IS NULL
        AND entitlement_source = 'self_hosted'
      )
    ) IS TRUE) NOT VALID;

ALTER TABLE builders
  VALIDATE CONSTRAINT builders_plan_check,
  VALIDATE CONSTRAINT builders_entitlement_combination_check;

-- Restore the migration principal before db:migrate records this file in
-- schema_migrations inside the same runner-owned transaction.
RESET ROLE;
