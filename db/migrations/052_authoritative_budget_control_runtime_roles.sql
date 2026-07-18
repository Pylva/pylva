-- 052: dedicated runtime privileges and bounded cross-tenant discovery for
-- authoritative budget-control workers.
--
-- The outbox is FORCE RLS protected, so a normal application login cannot
-- discover which tenant should be processed next without scanning builders
-- and entering every tenant context. This migration exposes two deliberately
-- narrow SECURITY DEFINER functions. Their owners cannot log in, own no data,
-- bypass no RLS policy, and can read only the columns needed to return
-- actionable builder UUIDs.
-- Authoritative budget-control connections inherit a separate fixed
-- pylva_budget_control_runtime group role;
-- that role remains NOBYPASSRLS and has no membership path to the function
-- owner. Applying this migration requires the database-owning migration
-- principal to have CREATEROLE; it does not require SUPERUSER or BYPASSRLS.

DO $role$
BEGIN
  BEGIN
    CREATE ROLE pylva_budget_projection_discovery_owner
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;

  BEGIN
    CREATE ROLE pylva_budget_expiry_discovery_owner
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END;
$role$;

-- A standard CREATEROLE principal cannot toggle SUPERUSER, REPLICATION, or
-- BYPASSRLS even to their safer values. Validate existing global roles and
-- fail closed on drift instead of requiring superuser authority on replay.
DO $owner_role_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname IN (
      'pylva_budget_projection_discovery_owner',
      'pylva_budget_expiry_discovery_owner'
    )
      AND (
        role.rolcanlogin
        OR role.rolsuper
        OR role.rolcreatedb
        OR role.rolcreaterole
        OR role.rolinherit
        OR role.rolreplication
        OR role.rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'budget discovery owner role attributes are unsafe'
      USING ERRCODE = '55000';
  END IF;
END;
$owner_role_contract$;

DO $role$
BEGIN
  BEGIN
    CREATE ROLE pylva_budget_control_runtime
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS;
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END;
$role$;

DO $runtime_role_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = 'pylva_budget_control_runtime'
      AND (
        role.rolcanlogin
        OR role.rolsuper
        OR role.rolcreatedb
        OR role.rolcreaterole
        OR role.rolinherit
        OR role.rolreplication
        OR role.rolbypassrls
      )
  ) THEN
    RAISE EXCEPTION 'budget-control runtime role attributes are unsafe'
      USING ERRCODE = '55000';
  END IF;
END;
$runtime_role_contract$;

-- PostgreSQL 16+ records one implicit creator-admin edge for a role created by
-- CREATEROLE. It is safe only when it points to this migration role with both
-- INHERIT and SET disabled. Reject every other inbound or outbound edge.
DO $owner_membership_contract$
DECLARE
  owner_name TEXT;
BEGIN
  FOREACH owner_name IN ARRAY ARRAY[
    'pylva_budget_projection_discovery_owner',
    'pylva_budget_expiry_discovery_owner'
  ]
  LOOP
    IF (
      SELECT pg_catalog.count(*) <> 1
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = edge.roleid
      WHERE owner_role.rolname = owner_name
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = edge.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = edge.member
      WHERE owner_role.rolname = owner_name
        AND (
          member_role.rolname <> CURRENT_USER
          OR NOT member_role.rolcreaterole
          OR member_role.rolsuper
          OR member_role.rolbypassrls
          OR NOT edge.admin_option
          OR edge.inherit_option
          OR edge.set_option
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = edge.member
      WHERE owner_role.rolname = owner_name
    ) THEN
      RAISE EXCEPTION
        'budget discovery owner % has an unsafe role-membership graph',
        owner_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$owner_membership_contract$;

-- PostgreSQL requires the migration principal to be a member of a function's
-- new owner when it transfers ownership. These memberships exist only inside
-- the migration transaction and are revoked after both functions are sealed.
DO $temporary_owner_memberships$
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT pylva_budget_projection_discovery_owner TO %I WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY %I',
    CURRENT_USER,
    CURRENT_USER
  );
  EXECUTE pg_catalog.format(
    'GRANT pylva_budget_expiry_discovery_owner TO %I WITH ADMIN FALSE, INHERIT TRUE, SET TRUE GRANTED BY %I',
    CURRENT_USER,
    CURRENT_USER
  );
END;
$temporary_owner_memberships$;

-- SECURITY DEFINER owners must never be able to manufacture a sibling object
-- in public. A role-specific REVOKE is insufficient when PUBLIC has CREATE.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Runtime attestation treats PUBLIC relation and sequence access as an
-- ambient privilege escalation: every login inherits it even when its named
-- ACL is exact. Repair historical grants across the same complete public
-- object kinds inspected by the attestor. Table-level REVOKE does not clear
-- column ACLs, so reset those catalog entries explicitly as well.
DO $public_object_acl_reset$
DECLARE
  object_row RECORD;
  column_grant RECORD;
BEGIN
  FOR object_row IN
    SELECT namespace.nspname AS schema_name,
           relation.relname AS object_name,
           relation.relkind AS object_kind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY relation.relkind, relation.relname
  LOOP
    IF object_row.object_kind = 'S' THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM PUBLIC CASCADE',
        object_row.schema_name,
        object_row.object_name
      );
    ELSE
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC CASCADE',
        object_row.schema_name,
        object_row.object_name
      );
    END IF;
  END LOOP;

  FOR column_grant IN
    SELECT namespace.nspname AS schema_name,
           relation.relname AS relation_name,
           privilege.privilege_type,
           pg_catalog.string_agg(
             pg_catalog.format('%I', attribute.attname),
             ', ' ORDER BY attribute.attnum
           ) AS column_list
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND privilege.grantee = 0
      AND privilege.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      )
    GROUP BY namespace.nspname,
             relation.relname,
             privilege.privilege_type
    ORDER BY relation.relname, privilege.privilege_type
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE %I.%I FROM PUBLIC CASCADE',
      column_grant.privilege_type,
      column_grant.column_list,
      column_grant.schema_name,
      column_grant.relation_name
    );
  END LOOP;
END;
$public_object_acl_reset$;

-- Replay starts from zero across the whole application schema. This prevents
-- an historical table, sequence, or column grant from silently widening the
-- definer owner's data access beyond the discovery query below.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM pylva_budget_projection_discovery_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM pylva_budget_projection_discovery_owner;
DO $projection_column_acl$
DECLARE
  grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT namespace.nspname AS schema_name,
           class.relname AS relation_name,
           privilege.privilege_type,
           pg_catalog.string_agg(
             pg_catalog.format('%I', attribute.attname),
             ', ' ORDER BY attribute.attnum
           ) AS column_list
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS class
      ON class.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE namespace.nspname = 'public'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND grantee.rolname = 'pylva_budget_projection_discovery_owner'
      AND privilege.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      )
    GROUP BY namespace.nspname,
             class.relname,
             privilege.privilege_type
    ORDER BY class.relname, privilege.privilege_type
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE %I.%I FROM pylva_budget_projection_discovery_owner',
      grant_row.privilege_type,
      grant_row.column_list,
      grant_row.schema_name,
      grant_row.relation_name
    );
  END LOOP;
END;
$projection_column_acl$;

REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM pylva_budget_projection_discovery_owner;
GRANT USAGE, CREATE ON SCHEMA public
  TO pylva_budget_projection_discovery_owner;
GRANT SELECT (
  builder_id,
  status,
  attempts,
  available_at,
  lock_expires_at,
  projection_verified_at
) ON TABLE public.budget_cost_event_outbox
  TO pylva_budget_projection_discovery_owner;

-- The dedicated runtime is non-owner, while FORCE also keeps accidental
-- owner-path calls subject to the same tenant boundary.
ALTER TABLE public.builders FORCE ROW LEVEL SECURITY;
ALTER TABLE public.rules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cost_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE public.custom_pricing FORCE ROW LEVEL SECURITY;

-- A SET LOCAL custom GUC is restored as an empty string on a pooled session,
-- and callers can supply arbitrary text. Preserve the tenant policy's valid
-- UUID behavior while treating absent, empty, or malformed settings as no
-- tenant instead of throwing during discovery policy evaluation.
DROP POLICY IF EXISTS budget_cost_event_outbox_isolation
  ON public.budget_cost_event_outbox;
CREATE POLICY budget_cost_event_outbox_isolation
  ON public.budget_cost_event_outbox
  USING (
    builder_id = CASE
      WHEN pg_catalog.pg_input_is_valid(
        pg_catalog.current_setting('app.builder_id', TRUE),
        'uuid'
      ) THEN pg_catalog.current_setting('app.builder_id', TRUE)::pg_catalog.uuid
      ELSE NULL::pg_catalog.uuid
    END
  )
  WITH CHECK (
    builder_id = CASE
      WHEN pg_catalog.pg_input_is_valid(
        pg_catalog.current_setting('app.builder_id', TRUE),
        'uuid'
      ) THEN pg_catalog.current_setting('app.builder_id', TRUE)::pg_catalog.uuid
      ELSE NULL::pg_catalog.uuid
    END
  );

-- The existing tenant policy is permissive and applies to PUBLIC. Pair a
-- role-specific permissive discovery policy with an identical restrictive
-- ceiling so inherited tenant GUCs can never widen the definer owner's view
-- beyond actionable rows.
DROP POLICY IF EXISTS budget_cost_event_outbox_projection_discovery_allow
  ON public.budget_cost_event_outbox;
CREATE POLICY budget_cost_event_outbox_projection_discovery_allow
  ON public.budget_cost_event_outbox
  AS PERMISSIVE
  FOR SELECT
  TO pylva_budget_projection_discovery_owner
  USING (
    (
      status = 'pending'
      AND available_at <= pg_catalog.statement_timestamp()
      AND attempts < 2147483646
    )
    OR (
      status = 'processing'
      AND lock_expires_at <= pg_catalog.statement_timestamp()
    )
    OR (
      status = 'projected'
      AND projection_verified_at IS NULL
    )
  );

DROP POLICY IF EXISTS budget_cost_event_outbox_projection_discovery_limit
  ON public.budget_cost_event_outbox;
CREATE POLICY budget_cost_event_outbox_projection_discovery_limit
  ON public.budget_cost_event_outbox
  AS RESTRICTIVE
  FOR SELECT
  TO pylva_budget_projection_discovery_owner
  USING (
    (
      status = 'pending'
      AND available_at <= pg_catalog.statement_timestamp()
      AND attempts < 2147483646
    )
    OR (
      status = 'processing'
      AND lock_expires_at <= pg_catalog.statement_timestamp()
    )
    OR (
      status = 'projected'
      AND projection_verified_at IS NULL
    )
  );

-- The pending and expired-processing arms already have partial indexes from
-- migration 050. This completes the BitmapOr for projected rows awaiting
-- reconciliation without indexing verified history.
CREATE INDEX IF NOT EXISTS idx_budget_cost_event_outbox_projected_unverified
  ON public.budget_cost_event_outbox (builder_id)
  WHERE status = 'projected'
    AND projection_verified_at IS NULL;

CREATE OR REPLACE FUNCTION public.pylva_budget_projection_actionable_builders(
  p_after_builder_id pg_catalog.uuid DEFAULT NULL,
  p_limit pg_catalog.int4 DEFAULT 250
)
RETURNS TABLE (builder_id pg_catalog.uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'projection discovery limit must be an integer between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT actionable.builder_id
  FROM (
    SELECT outbox.builder_id
    FROM public.budget_cost_event_outbox AS outbox
    WHERE (p_after_builder_id IS NULL OR outbox.builder_id > p_after_builder_id)
      AND (
        (
          outbox.status = 'pending'
          AND outbox.available_at <= pg_catalog.statement_timestamp()
          AND outbox.attempts < 2147483646
        )
        OR (
          outbox.status = 'processing'
          AND outbox.lock_expires_at <= pg_catalog.statement_timestamp()
        )
        OR (
          outbox.status = 'projected'
          AND outbox.projection_verified_at IS NULL
        )
      )
    GROUP BY outbox.builder_id
  ) AS actionable
  ORDER BY actionable.builder_id ASC
  LIMIT p_limit;
END;
$function$;

ALTER FUNCTION public.pylva_budget_projection_actionable_builders(
  pg_catalog.uuid,
  pg_catalog.int4
) OWNER TO pylva_budget_projection_discovery_owner;

-- CREATE OR REPLACE preserves an existing function ACL. Remove every named
-- grantee other than the sealed owner before granting the one runtime entry.
REVOKE ALL PRIVILEGES ON FUNCTION
  public.pylva_budget_projection_actionable_builders(
    pg_catalog.uuid,
    pg_catalog.int4
  )
  FROM PUBLIC;
DO $projection_function_acl_reset$
DECLARE
  grantee_name TEXT;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE procedure.oid =
          'public.pylva_budget_projection_actionable_builders(uuid,integer)'::pg_catalog.regprocedure
      AND grantee.rolname <> 'pylva_budget_projection_discovery_owner'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.pylva_budget_projection_actionable_builders(pg_catalog.uuid, pg_catalog.int4) FROM %I CASCADE',
      grantee_name
    );
  END LOOP;
END;
$projection_function_acl_reset$;
GRANT EXECUTE ON FUNCTION
  public.pylva_budget_projection_actionable_builders(
    pg_catalog.uuid,
    pg_catalog.int4
  )
  TO pylva_budget_control_runtime;

COMMENT ON FUNCTION public.pylva_budget_projection_actionable_builders(
  pg_catalog.uuid,
  pg_catalog.int4
) IS
  'Returns one bounded UUID-keyset page of builders with available pending rows, expired leases, or projected rows awaiting reconciliation.';

-- The owner needs schema lookup but must not retain the ability to create
-- another object that could expand the SECURITY DEFINER surface.
REVOKE CREATE ON SCHEMA public
  FROM pylva_budget_projection_discovery_owner;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM pylva_budget_expiry_discovery_owner;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM pylva_budget_expiry_discovery_owner;
DO $expiry_column_acl$
DECLARE
  grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT namespace.nspname AS schema_name,
           class.relname AS relation_name,
           privilege.privilege_type,
           pg_catalog.string_agg(
             pg_catalog.format('%I', attribute.attname),
             ', ' ORDER BY attribute.attnum
           ) AS column_list
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS class
      ON class.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE namespace.nspname = 'public'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND grantee.rolname = 'pylva_budget_expiry_discovery_owner'
      AND privilege.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      )
    GROUP BY namespace.nspname,
             class.relname,
             privilege.privilege_type
    ORDER BY class.relname, privilege.privilege_type
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE %I.%I FROM pylva_budget_expiry_discovery_owner',
      grant_row.privilege_type,
      grant_row.column_list,
      grant_row.schema_name,
      grant_row.relation_name
    );
  END LOOP;
END;
$expiry_column_acl$;

REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM pylva_budget_expiry_discovery_owner;
GRANT USAGE, CREATE ON SCHEMA public
  TO pylva_budget_expiry_discovery_owner;
GRANT SELECT (
  builder_id,
  decision,
  state,
  expires_at
) ON TABLE public.budget_reservations
  TO pylva_budget_expiry_discovery_owner;

DROP POLICY IF EXISTS budget_reservations_isolation
  ON public.budget_reservations;
CREATE POLICY budget_reservations_isolation
  ON public.budget_reservations
  USING (
    builder_id = CASE
      WHEN pg_catalog.pg_input_is_valid(
        pg_catalog.current_setting('app.builder_id', TRUE),
        'uuid'
      ) THEN pg_catalog.current_setting('app.builder_id', TRUE)::pg_catalog.uuid
      ELSE NULL::pg_catalog.uuid
    END
  )
  WITH CHECK (
    builder_id = CASE
      WHEN pg_catalog.pg_input_is_valid(
        pg_catalog.current_setting('app.builder_id', TRUE),
        'uuid'
      ) THEN pg_catalog.current_setting('app.builder_id', TRUE)::pg_catalog.uuid
      ELSE NULL::pg_catalog.uuid
    END
  );

CREATE INDEX IF NOT EXISTS idx_budget_reservations_expiry_discovery
  ON public.budget_reservations (builder_id, expires_at, decision_id)
  WHERE state = 'reserved' AND decision = 'reserved';

DROP POLICY IF EXISTS budget_reservations_expiry_discovery_allow
  ON public.budget_reservations;
CREATE POLICY budget_reservations_expiry_discovery_allow
  ON public.budget_reservations
  AS PERMISSIVE
  FOR SELECT
  TO pylva_budget_expiry_discovery_owner
  USING (
    decision = 'reserved'
    AND state = 'reserved'
    AND expires_at <= pg_catalog.statement_timestamp()
  );

DROP POLICY IF EXISTS budget_reservations_expiry_discovery_limit
  ON public.budget_reservations;
CREATE POLICY budget_reservations_expiry_discovery_limit
  ON public.budget_reservations
  AS RESTRICTIVE
  FOR SELECT
  TO pylva_budget_expiry_discovery_owner
  USING (
    decision = 'reserved'
    AND state = 'reserved'
    AND expires_at <= pg_catalog.statement_timestamp()
  );

CREATE OR REPLACE FUNCTION public.pylva_budget_expiry_actionable_builders(
  p_after_builder_id pg_catalog.uuid DEFAULT NULL,
  p_limit pg_catalog.int4 DEFAULT 250
)
RETURNS TABLE (builder_id pg_catalog.uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'expiry discovery limit must be an integer between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT due.builder_id
  FROM (
    SELECT reservation.builder_id
    FROM public.budget_reservations AS reservation
    WHERE (p_after_builder_id IS NULL OR reservation.builder_id > p_after_builder_id)
      AND reservation.decision = 'reserved'
      AND reservation.state = 'reserved'
      AND reservation.expires_at <= pg_catalog.statement_timestamp()
    GROUP BY reservation.builder_id
  ) AS due
  ORDER BY due.builder_id ASC
  LIMIT p_limit;
END;
$function$;

ALTER FUNCTION public.pylva_budget_expiry_actionable_builders(
  pg_catalog.uuid,
  pg_catalog.int4
) OWNER TO pylva_budget_expiry_discovery_owner;

REVOKE ALL PRIVILEGES ON FUNCTION
  public.pylva_budget_expiry_actionable_builders(
    pg_catalog.uuid,
    pg_catalog.int4
  )
  FROM PUBLIC;
DO $expiry_function_acl_reset$
DECLARE
  grantee_name TEXT;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT grantee.rolname
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE procedure.oid =
          'public.pylva_budget_expiry_actionable_builders(uuid,integer)'::pg_catalog.regprocedure
      AND grantee.rolname <> 'pylva_budget_expiry_discovery_owner'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.pylva_budget_expiry_actionable_builders(pg_catalog.uuid, pg_catalog.int4) FROM %I CASCADE',
      grantee_name
    );
  END LOOP;
END;
$expiry_function_acl_reset$;
GRANT EXECUTE ON FUNCTION
  public.pylva_budget_expiry_actionable_builders(
    pg_catalog.uuid,
    pg_catalog.int4
  )
  TO pylva_budget_control_runtime;

COMMENT ON FUNCTION public.pylva_budget_expiry_actionable_builders(
  pg_catalog.uuid,
  pg_catalog.int4
) IS
  'Returns one bounded UUID-keyset page of builders with reserved reservations whose lease expiry is due.';

REVOKE CREATE ON SCHEMA public
  FROM pylva_budget_expiry_discovery_owner;

-------------------------------------------------------------------
-- Dedicated authoritative budget-control runtime privileges. The general app
-- DATABASE_URL is unchanged; only the BUDGET_CONTROL_DATABASE_URL login is a
-- member of this NOINHERIT, NOBYPASSRLS group.
-------------------------------------------------------------------
DO $database_privileges$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES ON DATABASE %I FROM pylva_budget_control_runtime',
    pg_catalog.current_database()
  );
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO pylva_budget_control_runtime',
    pg_catalog.current_database()
  );
END;
$database_privileges$;

REVOKE ALL PRIVILEGES ON SCHEMA public
  FROM pylva_budget_control_runtime;
GRANT USAGE ON SCHEMA public
  TO pylva_budget_control_runtime;

-- Start from zero on every current application relation, then grant only the
-- verbs exercised by the authoritative reservation, lifecycle, readiness,
-- expiry, projection, and budget-activity paths.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM pylva_budget_control_runtime;

-- Table-level REVOKE does not clear grants stored on individual columns.
-- Reset every current public column so replay removes historical ACL drift.
DO $runtime_column_acl_reset$
DECLARE
  grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT namespace.nspname AS schema_name,
           class.relname AS relation_name,
           privilege.privilege_type,
           pg_catalog.string_agg(
             pg_catalog.format('%I', attribute.attname),
             ', ' ORDER BY attribute.attnum
           ) AS column_list
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS class
      ON class.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN pg_catalog.pg_roles AS grantee
      ON grantee.oid = privilege.grantee
    WHERE namespace.nspname = 'public'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND grantee.rolname = 'pylva_budget_control_runtime'
      AND privilege.privilege_type IN (
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      )
    GROUP BY namespace.nspname,
             class.relname,
             privilege.privilege_type
    ORDER BY class.relname, privilege.privilege_type
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%s) ON TABLE %I.%I FROM pylva_budget_control_runtime',
      grant_row.privilege_type,
      grant_row.column_list,
      grant_row.schema_name,
      grant_row.relation_name
    );
  END LOOP;
END;
$runtime_column_acl_reset$;

GRANT SELECT, INSERT, UPDATE
  ON TABLE public.budget_accounts
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.budget_rule_revisions
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.budget_reservations
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.budget_reservation_allocations
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT
  ON TABLE public.budget_reservation_transitions
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT
  ON TABLE public.budget_usage_ledger
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.budget_cost_event_outbox
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT, UPDATE
  ON TABLE public.budget_control_cutovers
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT
  ON TABLE public.budget_account_opening_evidence
  TO pylva_budget_control_runtime;

-- Pricing resolution reads global/provider catalogs plus tenant custom prices
-- and cost sources. Mutable rule CRUD and its immutable revision write are one
-- dedicated budget-control transaction.
GRANT SELECT ON TABLE
  public.builders,
  public.cost_sources,
  public.custom_pricing,
  public.llm_pricing
  TO pylva_budget_control_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rules
  TO pylva_budget_control_runtime;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM pylva_budget_control_runtime;
GRANT USAGE ON SEQUENCE public.pylva_budget_authority_order_seq
  TO pylva_budget_control_runtime;

DO $temporary_owner_memberships$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE pylva_budget_projection_discovery_owner FROM %I GRANTED BY %I',
    CURRENT_USER,
    CURRENT_USER
  );
  EXECUTE pg_catalog.format(
    'REVOKE pylva_budget_expiry_discovery_owner FROM %I GRANTED BY %I',
    CURRENT_USER,
    CURRENT_USER
  );
END;
$temporary_owner_memberships$;

DO $final_owner_membership_contract$
DECLARE
  owner_name TEXT;
BEGIN
  FOREACH owner_name IN ARRAY ARRAY[
    'pylva_budget_projection_discovery_owner',
    'pylva_budget_expiry_discovery_owner'
  ]
  LOOP
    IF (
      SELECT pg_catalog.count(*) <> 1
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = edge.roleid
      WHERE owner_role.rolname = owner_name
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = edge.roleid
      JOIN pg_catalog.pg_roles AS member_role
        ON member_role.oid = edge.member
      WHERE owner_role.rolname = owner_name
        AND (
          member_role.rolname <> CURRENT_USER
          OR NOT member_role.rolcreaterole
          OR member_role.rolsuper
          OR member_role.rolbypassrls
          OR NOT edge.admin_option
          OR edge.inherit_option
          OR edge.set_option
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members AS edge
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = edge.member
      WHERE owner_role.rolname = owner_name
    ) THEN
      RAISE EXCEPTION
        'budget discovery owner % retained an unsafe role-membership graph',
        owner_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$final_owner_membership_contract$;

-- Seal the complete discovery-owner contract in the migration itself. These
-- checks use effective privilege functions, so an unsafe grant inherited from
-- PUBLIC is rejected even when the owner's direct ACL appears closed.
DO $final_discovery_owner_privilege_contract$
DECLARE
  expected RECORD;
  owner_oid pg_catalog.oid;
  runtime_oid pg_catalog.oid;
  direct_column_grant_count BIGINT;
BEGIN
  SELECT role.oid
  INTO runtime_oid
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = 'pylva_budget_control_runtime';

  IF runtime_oid IS NULL THEN
    RAISE EXCEPTION 'budget-control runtime role is missing'
      USING ERRCODE = '55000';
  END IF;

  FOR expected IN
    SELECT contract.*
    FROM (
      VALUES
        (
          'pylva_budget_projection_discovery_owner'::TEXT,
          'public.pylva_budget_projection_actionable_builders(uuid,integer)'::pg_catalog.regprocedure,
          'public.budget_cost_event_outbox'::pg_catalog.regclass,
          ARRAY[
            'builder_id',
            'status',
            'attempts',
            'available_at',
            'lock_expires_at',
            'projection_verified_at'
          ]::TEXT[]
        ),
        (
          'pylva_budget_expiry_discovery_owner'::TEXT,
          'public.pylva_budget_expiry_actionable_builders(uuid,integer)'::pg_catalog.regprocedure,
          'public.budget_reservations'::pg_catalog.regclass,
          ARRAY['builder_id', 'decision', 'state', 'expires_at']::TEXT[]
        )
    ) AS contract(
      owner_name,
      function_oid,
      relation_oid,
      column_names
    )
  LOOP
    SELECT role.oid
    INTO owner_oid
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = expected.owner_name;

    IF owner_oid IS NULL
       OR NOT pg_catalog.has_schema_privilege(owner_oid, 'public', 'USAGE')
       OR pg_catalog.has_schema_privilege(owner_oid, 'public', 'CREATE') THEN
      RAISE EXCEPTION
        'budget discovery owner % has unsafe effective schema privileges',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.relowner = owner_oid
    ) OR (
      SELECT pg_catalog.count(*) <> 1
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.proowner = owner_oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.proowner = owner_oid
        AND procedure.oid <> expected.function_oid
    ) THEN
      RAISE EXCEPTION
        'budget discovery owner % owns an unexpected database object',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
      WHERE procedure.oid = expected.function_oid
        AND namespace.nspname = 'public'
        AND language.lanname = 'plpgsql'
        AND procedure.proowner = owner_oid
        AND procedure.prokind = 'f'
        AND procedure.prosecdef
        AND procedure.provolatile = 's'
        AND NOT procedure.proisstrict
        AND NOT procedure.proleakproof
        AND procedure.proparallel = 'u'
        AND procedure.proretset
        AND procedure.prorettype = 'pg_catalog.uuid'::pg_catalog.regtype
        AND procedure.pronargdefaults = 2
        AND procedure.proconfig IS NOT DISTINCT FROM
            ARRAY['search_path=pg_catalog']::TEXT[]
        AND pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
            'p_after_builder_id uuid, p_limit integer'
        AND pg_catalog.pg_get_function_result(procedure.oid) =
            'TABLE(builder_id uuid)'
    ) THEN
      RAISE EXCEPTION
        'budget discovery function owned by % has unsafe execution metadata',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    IF (
      SELECT pg_catalog.count(*) <> 2
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = expected.function_oid
    ) OR (
      SELECT pg_catalog.count(DISTINCT privilege.grantee) <> 2
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = expected.function_oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = expected.function_oid
        AND (
          privilege.grantee NOT IN (owner_oid, runtime_oid)
          OR privilege.privilege_type <> 'EXECUTE'
          OR privilege.is_grantable
        )
    ) THEN
      RAISE EXCEPTION
        'budget discovery function owned by % has an unsafe ACL',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    -- Column grants never count as table grants. The owner must have no
    -- effective table-level verb on any application relation.
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN (
        VALUES
          ('SELECT'),
          ('INSERT'),
          ('UPDATE'),
          ('DELETE'),
          ('TRUNCATE'),
          ('REFERENCES'),
          ('TRIGGER')
      ) AS candidate(privilege)
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_table_privilege(
          owner_oid,
          relation.oid,
          candidate.privilege
        )
    ) THEN
      RAISE EXCEPTION
        'budget discovery owner % has an unsafe effective table privilege',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS sequence
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = sequence.relnamespace
      CROSS JOIN (
        VALUES ('SELECT'), ('UPDATE'), ('USAGE')
      ) AS candidate(privilege)
      WHERE namespace.nspname = 'public'
        AND sequence.relkind = 'S'
        AND pg_catalog.has_sequence_privilege(
          owner_oid,
          sequence.oid,
          candidate.privilege
        )
    ) THEN
      RAISE EXCEPTION
        'budget discovery owner % has an unsafe effective sequence privilege',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN (
        VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
      ) AS candidate(privilege)
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND pg_catalog.has_column_privilege(
          owner_oid,
          relation.oid,
          attribute.attnum,
          candidate.privilege
        )
        AND NOT (
          relation.oid = expected.relation_oid
          AND attribute.attname = ANY(expected.column_names)
          AND candidate.privilege = 'SELECT'
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(expected.column_names) AS column_name
      WHERE NOT pg_catalog.has_column_privilege(
        owner_oid,
        expected.relation_oid,
        column_name,
        'SELECT'
      )
    ) THEN
      RAISE EXCEPTION
        'budget discovery owner % has an unsafe effective column privilege',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;

    SELECT pg_catalog.count(*)
    INTO direct_column_grant_count
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND attribute.attacl IS NOT NULL
      AND privilege.grantee = owner_oid;

    IF direct_column_grant_count <>
       pg_catalog.cardinality(expected.column_names)
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = attribute.attrelid
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
         WHERE namespace.nspname = 'public'
           AND attribute.attacl IS NOT NULL
           AND privilege.grantee = owner_oid
           AND (
             relation.oid <> expected.relation_oid
             OR attribute.attname <> ALL(expected.column_names)
             OR privilege.privilege_type <> 'SELECT'
             OR privilege.is_grantable
           )
       ) THEN
      RAISE EXCEPTION
        'budget discovery owner % has an unsafe direct column ACL',
        expected.owner_name
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END;
$final_discovery_owner_privilege_contract$;

DO $final_public_object_acl_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS object
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = object.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND object.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND privilege.grantee = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'CREATE'
  ) THEN
    RAISE EXCEPTION
      'PUBLIC retained an unsafe public schema, relation, column, or sequence privilege'
      USING ERRCODE = '55000';
  END IF;
END;
$final_public_object_acl_contract$;
