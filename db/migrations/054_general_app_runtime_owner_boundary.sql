-- 054: make the general application owner boundary explicit when schema
-- migrations and request-serving traffic use different PostgreSQL logins.
--
-- Migrations 046 and 053 preserve the legacy application's documented
-- table-owner behavior: authentication/bootstrap queries run before a tenant
-- GUC exists, while normal tenant paths add app.builder_id in application
-- transactions. A fresh deployment whose MIGRATION_DATABASE_URL owns the
-- schema cannot preserve that behavior merely by removing FORCE RLS: a
-- distinct DATABASE_URL login is still a non-owner and migration 052 also
-- removed ambient PUBLIC table, sequence, and schema-CREATE privileges.
--
-- This migration assigns every public, pre-authoritative application object
-- to one fixed NOLOGIN owner group. The request-serving login inherits that
-- role through a separately provisioned membership; it is never granted
-- CREATEROLE, BYPASSRLS, SUPERUSER, or SET/admin authority over the group.
-- The migration principal retains separate ADMIN-only and SET-only,
-- non-inheriting edges so future migrations can alter these objects without
-- serving traffic as the owner. The nine authoritative/control tables, their
-- sequence, the migration ledger, and the migration-only 048 backup remain
-- outside this boundary.
--
-- Upgrade precondition: the migration principal must already be able to ALTER
-- every listed object (normally because it is the existing object owner, or
-- has a SET-capable membership in that owner role). This was already required
-- by migration 052. PostgreSQL intentionally rejects ALTER OWNER otherwise;
-- operators must repair ownership before retrying rather than use SUPERUSER in
-- the application or silently broaden this migration.

DO $role$
BEGIN
  BEGIN
    CREATE ROLE pylva_general_app_runtime
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

DO $role_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role
    WHERE role.rolname = 'pylva_general_app_runtime'
      AND NOT role.rolcanlogin
      AND NOT role.rolsuper
      AND NOT role.rolcreatedb
      AND NOT role.rolcreaterole
      AND NOT role.rolinherit
      AND NOT role.rolreplication
      AND NOT role.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner role attributes are unsafe'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    JOIN pg_catalog.pg_roles AS role ON role.oid = database.datdba
    WHERE role.rolname = 'pylva_general_app_runtime'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    JOIN pg_catalog.pg_roles AS role ON role.oid = namespace.nspowner
    WHERE role.rolname = 'pylva_general_app_runtime'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS default_acl
    JOIN pg_catalog.pg_roles AS role ON role.oid = default_acl.defaclrole
    WHERE role.rolname = 'pylva_general_app_runtime'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS default_acl
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
    JOIN pg_catalog.pg_roles AS role ON role.oid = privilege.grantee
    WHERE role.rolname = 'pylva_general_app_runtime'
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner role has database, schema, or default-ACL ownership drift'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = edge.roleid
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    WHERE owner_role.rolname = 'pylva_general_app_runtime'
      AND member_role.rolname <> CURRENT_USER
      AND NOT (
        member_role.rolcanlogin
        AND member_role.rolinherit
        AND NOT member_role.rolsuper
        AND NOT member_role.rolcreatedb
        AND NOT member_role.rolcreaterole
        AND NOT member_role.rolreplication
        AND NOT member_role.rolbypassrls
        AND NOT edge.admin_option
        AND edge.inherit_option
        AND NOT edge.set_option
      )
  ) OR (
    SELECT pg_catalog.count(*) > 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = edge.roleid
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    WHERE owner_role.rolname = 'pylva_general_app_runtime'
      AND member_role.rolname <> CURRENT_USER
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = edge.member
    WHERE owner_role.rolname = 'pylva_general_app_runtime'
  ) OR EXISTS (
    -- A role that is a member of the request-serving login would inherit the
    -- login's new owner membership transitively. Reject that graph before the
    -- owner edge can become a privilege-escalation bridge.
    SELECT 1
    FROM pg_catalog.pg_auth_members AS owner_edge
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = owner_edge.roleid
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = owner_edge.member
    JOIN pg_catalog.pg_auth_members AS login_member_edge
      ON login_member_edge.roleid = member_role.oid
    JOIN pg_catalog.pg_roles AS login_member_role
      ON login_member_role.oid = login_member_edge.member
    WHERE owner_role.rolname = 'pylva_general_app_runtime'
      AND member_role.rolname <> CURRENT_USER
      AND NOT (
        login_member_role.rolname = CURRENT_USER
        AND login_member_role.rolcreaterole
        AND NOT login_member_role.rolsuper
        AND NOT login_member_role.rolbypassrls
        AND login_member_edge.admin_option
        AND NOT login_member_edge.inherit_option
        AND NOT login_member_edge.set_option
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS owner_edge
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = owner_edge.roleid
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = owner_edge.member
    WHERE owner_role.rolname = 'pylva_general_app_runtime'
      AND member_role.rolname <> CURRENT_USER
      AND (
        SELECT pg_catalog.count(*) > 1
        FROM pg_catalog.pg_auth_members AS login_member_edge
        WHERE login_member_edge.roleid = member_role.oid
      )
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner role has an unsafe membership graph'
      USING ERRCODE = '55000';
  END IF;

END;
$role_contract$;

-- PostgreSQL 16+ creates a creator-admin edge with SET disabled. A role cannot
-- grant ADMIN back to its own grantor, so retain that implicit admin edge and
-- add one non-admin, SET-enabled self-grant. Together they let the migrator
-- manage membership and opt into owner authority for DDL, while neither edge
-- inherits owner privileges during ordinary migration queries.
DO $migration_membership$
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT pylva_general_app_runtime TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I',
    CURRENT_USER,
    CURRENT_USER
  );
END;
$migration_membership$;

-- PostgreSQL requires the destination owner to have CREATE on the containing
-- schema before ALTER OWNER. The exact schema ACL is reset and attested again
-- after all ownership transfers.
GRANT USAGE, CREATE ON SCHEMA public TO pylva_general_app_runtime;

-- Exact application relation allowlist. Adding a pre-authoritative table in a
-- future migration requires an explicit ownership decision and contract
-- update; no wildcard can silently expand the request-serving boundary.
DO $legacy_relations$
DECLARE
  relation_name pg_catalog.name;
  current_owner pg_catalog.name;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'alert_history',
    'anomaly_events',
    'api_key_vault',
    'api_keys',
    'audit_log',
    'builder_alert_config',
    'builder_feature_flags',
    'builders',
    'cost_sources',
    'custom_pricing',
    'custom_rule_requests',
    'customer_pricing',
    'customers',
    'feature_flag_overrides',
    'invites',
    'invoice_idempotency',
    'invoices',
    'llm_pricing',
    'portal_access_grants',
    'portal_configs',
    'portal_domains',
    'portal_links',
    'portal_sessions',
    'pricing_onboarding_tasks',
    'pricing_sync_log',
    'rule_alert_channels',
    'rule_events',
    'rules',
    'stripe_connect',
    'stripe_connect_event_log',
    'user_builder_memberships',
    'users',
    'webhook_configs',
    'webhook_dlq'
  ]::pg_catalog.name[]
  LOOP
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO current_owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = relation_name
      AND relation.relkind IN ('r', 'p');

    IF current_owner IS NULL THEN
      RAISE EXCEPTION 'required general-app relation public.% is missing', relation_name
        USING ERRCODE = '42P01';
    END IF;

    IF current_owner <> 'pylva_general_app_runtime' THEN
      IF current_owner <> CURRENT_USER THEN
        RAISE EXCEPTION
          'general-app ownership upgrade precondition failed for public.%: owner is %, migrator is %',
          relation_name,
          current_owner,
          CURRENT_USER
          USING ERRCODE = '42501';
      END IF;
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I OWNER TO pylva_general_app_runtime',
        relation_name
      );
    END IF;
  END LOOP;
END;
$legacy_relations$;

-- The partition runway is date-dependent, so enumerate only children of the
-- explicitly allowlisted audit_log parent rather than matching a name prefix.
-- Historical migrations interpreted DATE bounds in their migration session's
-- TimeZone. Validate that convention before transfer; an upgrade run in a
-- different zone must fail rather than create a future gap or overlap.
DO $audit_partitions$
DECLARE
  partition_row RECORD;
  month_start pg_catalog.date;
  next_month pg_catalog.date;
  expected_bound pg_catalog.text;
BEGIN
  FOR partition_row IN
    SELECT child.relname AS partition_name,
           child.relkind AS partition_kind,
           pg_catalog.pg_get_userbyid(child.relowner) AS partition_owner,
           pg_catalog.pg_get_expr(child.relpartbound, child.oid) AS partition_bound
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
    JOIN pg_catalog.pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
    JOIN pg_catalog.pg_namespace AS child_namespace
      ON child_namespace.oid = child.relnamespace
    WHERE parent_namespace.nspname = 'public'
      AND parent.relname = 'audit_log'
      AND child_namespace.nspname = 'public'
    ORDER BY child.relname
  LOOP
    IF partition_row.partition_kind <> 'r'
       OR partition_row.partition_name !~ '^audit_log_y[0-9]{4}m(0[1-9]|1[0-2])$' THEN
      RAISE EXCEPTION 'audit_log has an unsafe child relation: %',
        partition_row.partition_name
        USING ERRCODE = '55000';
    END IF;

    month_start := pg_catalog.make_date(
      pg_catalog.substr(partition_row.partition_name, 12, 4)::pg_catalog.int4,
      pg_catalog.substr(partition_row.partition_name, 17, 2)::pg_catalog.int4,
      1
    );
    next_month := (month_start + INTERVAL '1 month')::pg_catalog.date;
    expected_bound := pg_catalog.format(
      'FOR VALUES FROM (%L) TO (%L)',
      month_start::pg_catalog.timestamptz,
      next_month::pg_catalog.timestamptz
    );

    IF partition_row.partition_bound IS DISTINCT FROM expected_bound THEN
      RAISE EXCEPTION
        'audit partition %.% bounds do not match migration TimeZone %; rerun migration 054 using the historical partition TimeZone',
        'public',
        partition_row.partition_name,
        pg_catalog.current_setting('TimeZone')
        USING ERRCODE = '55000';
    END IF;

    IF partition_row.partition_owner <> 'pylva_general_app_runtime' THEN
      IF partition_row.partition_owner <> CURRENT_USER THEN
        RAISE EXCEPTION
          'general-app ownership upgrade precondition failed for public.%: owner is %, migrator is %',
          partition_row.partition_name,
          partition_row.partition_owner,
          CURRENT_USER
          USING ERRCODE = '42501';
      END IF;
      EXECUTE pg_catalog.format(
        'ALTER TABLE public.%I OWNER TO pylva_general_app_runtime',
        partition_row.partition_name
      );
    END IF;
  END LOOP;
END;
$audit_partitions$;

DO $legacy_view_sequence_function$
DECLARE
  object_name pg_catalog.name;
  current_owner pg_catalog.name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(relation.relowner)
  INTO current_owner
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'webhook_configs_with_grace'
    AND relation.relkind = 'v';
  IF current_owner <> 'pylva_general_app_runtime' THEN
    IF current_owner IS DISTINCT FROM CURRENT_USER THEN
      RAISE EXCEPTION 'general-app ownership upgrade precondition failed for public.webhook_configs_with_grace'
        USING ERRCODE = '42501';
    END IF;
    ALTER VIEW public.webhook_configs_with_grace OWNER TO pylva_general_app_runtime;
  END IF;

  FOREACH object_name IN ARRAY ARRAY[
    'api_key_vault_id_seq',
    'audit_log_id_seq',
    'llm_pricing_id_seq'
  ]::pg_catalog.name[]
  LOOP
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    INTO current_owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = object_name
      AND relation.relkind = 'S';
    IF current_owner <> 'pylva_general_app_runtime' THEN
      IF current_owner IS DISTINCT FROM CURRENT_USER THEN
        RAISE EXCEPTION
          'general-app ownership upgrade precondition failed for public.%',
          object_name
          USING ERRCODE = '42501';
      END IF;
      EXECUTE pg_catalog.format(
        'ALTER SEQUENCE public.%I OWNER TO pylva_general_app_runtime',
        object_name
      );
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_userbyid(procedure.proowner)
  INTO current_owner
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = 'public.generate_slug(text)'::pg_catalog.regprocedure;
  IF current_owner <> 'pylva_general_app_runtime' THEN
    IF current_owner IS DISTINCT FROM CURRENT_USER THEN
      RAISE EXCEPTION 'general-app ownership upgrade precondition failed for public.generate_slug(text)'
        USING ERRCODE = '42501';
    END IF;
    ALTER FUNCTION public.generate_slug(pg_catalog.text)
      OWNER TO pylva_general_app_runtime;
  END IF;
END;
$legacy_view_sequence_function$;

-- Run function DDL as the fixed NOLOGIN owner on both first apply and raw
-- replay. The migration role's non-inheriting SET edge makes this explicit.
SET ROLE pylva_general_app_runtime;

CREATE OR REPLACE FUNCTION public.pylva_ensure_audit_log_partition(
  p_month_start pg_catalog.date
)
RETURNS pg_catalog.bool
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET TimeZone FROM CURRENT
AS $function$
DECLARE
  utc_current_month pg_catalog.date :=
    pg_catalog.date_trunc(
      'month',
      pg_catalog.statement_timestamp() AT TIME ZONE 'UTC'
    )::pg_catalog.date;
  next_month pg_catalog.date;
  partition_name pg_catalog.name;
  existing_owner pg_catalog.name;
  existing_is_partition pg_catalog.bool;
  existing_kind "char";
  existing_bound pg_catalog.text;
  expected_bound pg_catalog.text;
BEGIN
  IF p_month_start IS NULL
     OR p_month_start <> pg_catalog.date_trunc('month', p_month_start)::pg_catalog.date
     OR p_month_start < utc_current_month
     OR p_month_start > (utc_current_month + INTERVAL '12 months')::pg_catalog.date THEN
    RAISE EXCEPTION 'audit partition month is outside the managed UTC runway'
      USING ERRCODE = '22023';
  END IF;

  next_month := (p_month_start + INTERVAL '1 month')::pg_catalog.date;
  partition_name := (
    'audit_log_y'
    || pg_catalog.to_char(p_month_start, 'YYYY')
    || 'm'
    || pg_catalog.to_char(p_month_start, 'MM')
  )::pg_catalog.name;
  expected_bound := pg_catalog.format(
    'FOR VALUES FROM (%L) TO (%L)',
    p_month_start::pg_catalog.timestamptz,
    next_month::pg_catalog.timestamptz
  );

  -- Serialize the existence check and DDL without relying on a caller-owned
  -- session lock. The key is namespaced to this one bounded operation.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pylva:audit-partition:' || partition_name::pg_catalog.text,
      0
    )
  );

  SELECT pg_catalog.pg_get_userbyid(relation.relowner),
         relation.relkind,
         pg_catalog.pg_get_expr(relation.relpartbound, relation.oid),
         EXISTS (
           SELECT 1
           FROM pg_catalog.pg_inherits AS inheritance
           JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
           JOIN pg_catalog.pg_namespace AS parent_namespace
             ON parent_namespace.oid = parent.relnamespace
           WHERE inheritance.inhrelid = relation.oid
             AND parent_namespace.nspname = 'public'
             AND parent.relname = 'audit_log'
         )
  INTO existing_owner, existing_kind, existing_bound, existing_is_partition
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = partition_name;

  IF FOUND THEN
    IF existing_owner <> 'pylva_general_app_runtime'
       OR existing_kind <> 'r'
       OR NOT existing_is_partition
       OR existing_bound IS DISTINCT FROM expected_bound THEN
      RAISE EXCEPTION 'audit partition name collides with an unsafe object'
        USING ERRCODE = '42P07';
    END IF;
    RETURN FALSE;
  END IF;

  EXECUTE pg_catalog.format(
    'CREATE TABLE public.%I PARTITION OF public.audit_log FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    p_month_start,
    next_month
  );
  RETURN TRUE;
END;
$function$;

REVOKE ALL PRIVILEGES ON FUNCTION
  public.pylva_ensure_audit_log_partition(pg_catalog.date)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  public.pylva_ensure_audit_log_partition(pg_catalog.date)
  TO pylva_general_app_runtime;

RESET ROLE;

-- CREATE remains an explicit temporary compatibility privilege of this owner
-- bridge. The application route uses only the bounded definer above; future
-- non-owner general-runtime work can remove this broader legacy capability.
DO $database_privileges$
BEGIN
  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES ON DATABASE %I FROM pylva_general_app_runtime',
    pg_catalog.current_database()
  );
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO pylva_general_app_runtime',
    pg_catalog.current_database()
  );
END;
$database_privileges$;

REVOKE ALL PRIVILEGES ON SCHEMA public FROM pylva_general_app_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO pylva_general_app_runtime;

-- Read-only migration-head visibility is required by the general health and
-- readiness surface. The ledger remains migration-owned and is never writable
-- through DATABASE_URL.
REVOKE ALL PRIVILEGES ON TABLE public.schema_migrations
  FROM pylva_general_app_runtime, PUBLIC;
GRANT SELECT ON TABLE public.schema_migrations
  TO pylva_general_app_runtime;

-- Explicitly close direct authority ACLs even if this fixed role was
-- pre-created with drift. Ownership is checked separately below.
REVOKE ALL PRIVILEGES ON TABLE
  public.budget_account_opening_evidence,
  public.budget_accounts,
  public.budget_control_cutovers,
  public.budget_cost_event_outbox,
  public.budget_reservation_allocations,
  public.budget_reservation_transitions,
  public.budget_reservations,
  public.budget_rule_revisions,
  public.budget_usage_ledger
  FROM pylva_general_app_runtime, PUBLIC;
REVOKE ALL PRIVILEGES ON SEQUENCE public.pylva_budget_authority_order_seq
  FROM pylva_general_app_runtime, PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public._048_api_keys_scope_backup
  FROM pylva_general_app_runtime, PUBLIC;

-- Table-level REVOKE does not remove column-level grants. Remove both direct
-- owner-group and ambient PUBLIC column ACLs on authority tables so membership
-- in the legacy owner group can never reveal even one authoritative column.
DO $authority_column_acl$
DECLARE
  grant_row RECORD;
BEGIN
  FOR grant_row IN
    SELECT relation.relname AS relation_name,
           attribute.attname AS column_name,
           privilege.privilege_type,
           privilege.grantee
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee ON grantee.oid = privilege.grantee
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'budget_account_opening_evidence',
        'budget_accounts',
        'budget_control_cutovers',
        'budget_cost_event_outbox',
        'budget_reservation_allocations',
        'budget_reservation_transitions',
        'budget_reservations',
        'budget_rule_revisions',
        'budget_usage_ledger',
        'schema_migrations',
        '_048_api_keys_scope_backup'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        privilege.grantee = 0
        OR grantee.rolname = 'pylva_general_app_runtime'
      )
    ORDER BY relation.relname, attribute.attnum, privilege.privilege_type
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE %s (%I) ON TABLE public.%I FROM %s',
      grant_row.privilege_type,
      grant_row.column_name,
      grant_row.relation_name,
      CASE
        WHEN grant_row.grantee = 0 THEN 'PUBLIC'
        ELSE 'pylva_general_app_runtime'
      END
    );
  END LOOP;
END;
$authority_column_acl$;

DO $final_contract$
DECLARE
  owner_oid pg_catalog.oid;
  expected_relation_count pg_catalog.int4;
  actual_relation_count pg_catalog.int4;
BEGIN
  SELECT role.oid
  INTO owner_oid
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = 'pylva_general_app_runtime'
    AND NOT role.rolcanlogin
    AND NOT role.rolsuper
    AND NOT role.rolcreatedb
    AND NOT role.rolcreaterole
    AND NOT role.rolinherit
    AND NOT role.rolreplication
    AND NOT role.rolbypassrls;

  IF owner_oid IS NULL THEN
    RAISE EXCEPTION 'general-app runtime owner role contract is missing'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    WHERE database.datdba = owner_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    WHERE namespace.nspowner = owner_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS default_acl
    WHERE default_acl.defaclrole = owner_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS default_acl
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
    WHERE privilege.grantee = owner_oid
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner role retained database, schema, or default-ACL ownership drift'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT pg_catalog.count(*) NOT IN (2, 3)
    FROM pg_catalog.pg_auth_members AS edge
    WHERE edge.roleid = owner_oid
  ) OR (
    SELECT pg_catalog.count(*) <> 2
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    WHERE edge.roleid = owner_oid
      AND member_role.rolname = CURRENT_USER
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    WHERE edge.roleid = owner_oid
      AND member_role.rolname = CURRENT_USER
      AND (
        NOT member_role.rolcreaterole
        OR member_role.rolsuper
        OR member_role.rolbypassrls
        OR edge.inherit_option
        OR NOT (
          (edge.admin_option AND NOT edge.set_option)
          OR (NOT edge.admin_option AND edge.set_option)
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    WHERE edge.roleid = owner_oid
      AND member_role.rolname <> CURRENT_USER
      AND (
        NOT member_role.rolcanlogin
        OR NOT member_role.rolinherit
        OR member_role.rolsuper
        OR member_role.rolcreatedb
        OR member_role.rolcreaterole
        OR member_role.rolreplication
        OR member_role.rolbypassrls
        OR edge.admin_option
        OR NOT edge.inherit_option
        OR edge.set_option
      )
  ) OR (
    SELECT pg_catalog.count(*) > 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = edge.member
    WHERE edge.roleid = owner_oid
      AND member_role.rolname <> CURRENT_USER
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    WHERE edge.member = owner_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS owner_edge
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = owner_edge.member
    JOIN pg_catalog.pg_auth_members AS login_member_edge
      ON login_member_edge.roleid = member_role.oid
    JOIN pg_catalog.pg_roles AS login_member_role
      ON login_member_role.oid = login_member_edge.member
    WHERE owner_edge.roleid = owner_oid
      AND member_role.rolname <> CURRENT_USER
      AND NOT (
        login_member_role.rolname = CURRENT_USER
        AND login_member_role.rolcreaterole
        AND NOT login_member_role.rolsuper
        AND NOT login_member_role.rolbypassrls
        AND login_member_edge.admin_option
        AND NOT login_member_edge.inherit_option
        AND NOT login_member_edge.set_option
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS owner_edge
    JOIN pg_catalog.pg_roles AS member_role ON member_role.oid = owner_edge.member
    WHERE owner_edge.roleid = owner_oid
      AND member_role.rolname <> CURRENT_USER
      AND (
        SELECT pg_catalog.count(*) > 1
        FROM pg_catalog.pg_auth_members AS login_member_edge
        WHERE login_member_edge.roleid = member_role.oid
      )
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner role retained an unsafe membership graph'
      USING ERRCODE = '55000';
  END IF;

  WITH expected_relations(relation_name, relation_kind) AS (
    VALUES
      ('alert_history', 'r'::"char"),
      ('anomaly_events', 'r'::"char"),
      ('api_key_vault', 'r'::"char"),
      ('api_key_vault_id_seq', 'S'::"char"),
      ('api_keys', 'r'::"char"),
      ('audit_log', 'p'::"char"),
      ('audit_log_id_seq', 'S'::"char"),
      ('builder_alert_config', 'r'::"char"),
      ('builder_feature_flags', 'r'::"char"),
      ('builders', 'r'::"char"),
      ('cost_sources', 'r'::"char"),
      ('custom_pricing', 'r'::"char"),
      ('custom_rule_requests', 'r'::"char"),
      ('customer_pricing', 'r'::"char"),
      ('customers', 'r'::"char"),
      ('feature_flag_overrides', 'r'::"char"),
      ('invites', 'r'::"char"),
      ('invoice_idempotency', 'r'::"char"),
      ('invoices', 'r'::"char"),
      ('llm_pricing', 'r'::"char"),
      ('llm_pricing_id_seq', 'S'::"char"),
      ('portal_access_grants', 'r'::"char"),
      ('portal_configs', 'r'::"char"),
      ('portal_domains', 'r'::"char"),
      ('portal_links', 'r'::"char"),
      ('portal_sessions', 'r'::"char"),
      ('pricing_onboarding_tasks', 'r'::"char"),
      ('pricing_sync_log', 'r'::"char"),
      ('rule_alert_channels', 'r'::"char"),
      ('rule_events', 'r'::"char"),
      ('rules', 'r'::"char"),
      ('stripe_connect', 'r'::"char"),
      ('stripe_connect_event_log', 'r'::"char"),
      ('user_builder_memberships', 'r'::"char"),
      ('users', 'r'::"char"),
      ('webhook_configs', 'r'::"char"),
      ('webhook_configs_with_grace', 'v'::"char"),
      ('webhook_dlq', 'r'::"char")
  ), audit_partitions AS (
    SELECT child.relname AS relation_name, child.relkind AS relation_kind
    FROM pg_catalog.pg_inherits AS inheritance
    JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
    JOIN pg_catalog.pg_namespace AS parent_namespace
      ON parent_namespace.oid = parent.relnamespace
    JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
    JOIN pg_catalog.pg_namespace AS child_namespace
      ON child_namespace.oid = child.relnamespace
    WHERE parent_namespace.nspname = 'public'
      AND parent.relname = 'audit_log'
      AND child_namespace.nspname = 'public'
  ), complete_expected AS (
    SELECT * FROM expected_relations
    UNION ALL
    SELECT * FROM audit_partitions
  )
  SELECT pg_catalog.count(*)
  INTO expected_relation_count
  FROM complete_expected;

  SELECT pg_catalog.count(*)
  INTO actual_relation_count
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    AND relation.relowner = owner_oid;

  IF actual_relation_count <> expected_relation_count OR EXISTS (
    WITH expected_relations(relation_name, relation_kind) AS (
      VALUES
        ('alert_history', 'r'::"char"),
        ('anomaly_events', 'r'::"char"),
        ('api_key_vault', 'r'::"char"),
        ('api_key_vault_id_seq', 'S'::"char"),
        ('api_keys', 'r'::"char"),
        ('audit_log', 'p'::"char"),
        ('audit_log_id_seq', 'S'::"char"),
        ('builder_alert_config', 'r'::"char"),
        ('builder_feature_flags', 'r'::"char"),
        ('builders', 'r'::"char"),
        ('cost_sources', 'r'::"char"),
        ('custom_pricing', 'r'::"char"),
        ('custom_rule_requests', 'r'::"char"),
        ('customer_pricing', 'r'::"char"),
        ('customers', 'r'::"char"),
        ('feature_flag_overrides', 'r'::"char"),
        ('invites', 'r'::"char"),
        ('invoice_idempotency', 'r'::"char"),
        ('invoices', 'r'::"char"),
        ('llm_pricing', 'r'::"char"),
        ('llm_pricing_id_seq', 'S'::"char"),
        ('portal_access_grants', 'r'::"char"),
        ('portal_configs', 'r'::"char"),
        ('portal_domains', 'r'::"char"),
        ('portal_links', 'r'::"char"),
        ('portal_sessions', 'r'::"char"),
        ('pricing_onboarding_tasks', 'r'::"char"),
        ('pricing_sync_log', 'r'::"char"),
        ('rule_alert_channels', 'r'::"char"),
        ('rule_events', 'r'::"char"),
        ('rules', 'r'::"char"),
        ('stripe_connect', 'r'::"char"),
        ('stripe_connect_event_log', 'r'::"char"),
        ('user_builder_memberships', 'r'::"char"),
        ('users', 'r'::"char"),
        ('webhook_configs', 'r'::"char"),
        ('webhook_configs_with_grace', 'v'::"char"),
        ('webhook_dlq', 'r'::"char")
    ), audit_partitions AS (
      SELECT child.relname AS relation_name, child.relkind AS relation_kind
      FROM pg_catalog.pg_inherits AS inheritance
      JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
      JOIN pg_catalog.pg_namespace AS parent_namespace
        ON parent_namespace.oid = parent.relnamespace
      JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
      JOIN pg_catalog.pg_namespace AS child_namespace
        ON child_namespace.oid = child.relnamespace
      WHERE parent_namespace.nspname = 'public'
        AND parent.relname = 'audit_log'
        AND child_namespace.nspname = 'public'
    ), complete_expected AS (
      SELECT * FROM expected_relations
      UNION ALL
      SELECT * FROM audit_partitions
    ), actual_owned AS (
      SELECT relation.relname AS relation_name, relation.relkind AS relation_kind
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND relation.relowner = owner_oid
    )
    SELECT relation_name, relation_kind FROM complete_expected
    EXCEPT
    SELECT relation_name, relation_kind FROM actual_owned
  ) OR EXISTS (
    WITH expected_relations(relation_name, relation_kind) AS (
      VALUES
        ('alert_history', 'r'::"char"), ('anomaly_events', 'r'::"char"),
        ('api_key_vault', 'r'::"char"), ('api_key_vault_id_seq', 'S'::"char"),
        ('api_keys', 'r'::"char"), ('audit_log', 'p'::"char"),
        ('audit_log_id_seq', 'S'::"char"), ('builder_alert_config', 'r'::"char"),
        ('builder_feature_flags', 'r'::"char"), ('builders', 'r'::"char"),
        ('cost_sources', 'r'::"char"), ('custom_pricing', 'r'::"char"),
        ('custom_rule_requests', 'r'::"char"), ('customer_pricing', 'r'::"char"),
        ('customers', 'r'::"char"), ('feature_flag_overrides', 'r'::"char"),
        ('invites', 'r'::"char"), ('invoice_idempotency', 'r'::"char"),
        ('invoices', 'r'::"char"), ('llm_pricing', 'r'::"char"),
        ('llm_pricing_id_seq', 'S'::"char"), ('portal_access_grants', 'r'::"char"),
        ('portal_configs', 'r'::"char"), ('portal_domains', 'r'::"char"),
        ('portal_links', 'r'::"char"), ('portal_sessions', 'r'::"char"),
        ('pricing_onboarding_tasks', 'r'::"char"), ('pricing_sync_log', 'r'::"char"),
        ('rule_alert_channels', 'r'::"char"), ('rule_events', 'r'::"char"),
        ('rules', 'r'::"char"), ('stripe_connect', 'r'::"char"),
        ('stripe_connect_event_log', 'r'::"char"),
        ('user_builder_memberships', 'r'::"char"), ('users', 'r'::"char"),
        ('webhook_configs', 'r'::"char"),
        ('webhook_configs_with_grace', 'v'::"char"), ('webhook_dlq', 'r'::"char")
    ), audit_partitions AS (
      SELECT child.relname AS relation_name, child.relkind AS relation_kind
      FROM pg_catalog.pg_inherits AS inheritance
      JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
      JOIN pg_catalog.pg_namespace AS parent_namespace
        ON parent_namespace.oid = parent.relnamespace
      JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
      JOIN pg_catalog.pg_namespace AS child_namespace
        ON child_namespace.oid = child.relnamespace
      WHERE parent_namespace.nspname = 'public'
        AND parent.relname = 'audit_log'
        AND child_namespace.nspname = 'public'
    ), complete_expected AS (
      SELECT * FROM expected_relations
      UNION ALL
      SELECT * FROM audit_partitions
    ), actual_owned AS (
      SELECT relation.relname AS relation_name, relation.relkind AS relation_kind
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND relation.relowner = owner_oid
    )
    SELECT relation_name, relation_kind FROM actual_owned
    EXCEPT
    SELECT relation_name, relation_kind FROM complete_expected
  ) THEN
    RAISE EXCEPTION 'general-app runtime relation ownership contract is incomplete or widened'
      USING ERRCODE = '55000';
  END IF;

  IF (
    SELECT pg_catalog.count(*) <> 2
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.proowner = owner_oid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.proowner = owner_oid
      AND procedure.oid = 'public.generate_slug(text)'::pg_catalog.regprocedure
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.proowner = owner_oid
      AND procedure.oid =
        'public.pylva_ensure_audit_log_partition(date)'::pg_catalog.regprocedure
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig @> ARRAY[
        'search_path=pg_catalog',
        pg_catalog.format(
          'TimeZone=%s',
          pg_catalog.current_setting('TimeZone')
        )
      ]::pg_catalog.text[]
      AND pg_catalog.cardinality(procedure.proconfig) = 2
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'general-app runtime function ownership contract is incomplete or widened'
      USING ERRCODE = '55000';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(owner_oid, 'public', 'USAGE')
     OR NOT pg_catalog.has_schema_privilege(owner_oid, 'public', 'CREATE')
     OR NOT pg_catalog.has_database_privilege(
       owner_oid,
       pg_catalog.current_database(),
       'CONNECT'
     ) THEN
    RAISE EXCEPTION 'general-app runtime ambient privilege contract is incomplete'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
    ) AS candidate(privilege_type)
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'budget_account_opening_evidence',
        'budget_accounts',
        'budget_control_cutovers',
        'budget_cost_event_outbox',
        'budget_reservation_allocations',
        'budget_reservation_transitions',
        'budget_reservations',
        'budget_rule_revisions',
        'budget_usage_ledger',
        '_048_api_keys_scope_backup'
      )
      AND pg_catalog.has_table_privilege(
        owner_oid,
        relation.oid,
        candidate.privilege_type
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
      AS candidate(privilege_type)
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'pylva_budget_authority_order_seq'
      AND pg_catalog.has_sequence_privilege(
        owner_oid,
        relation.oid,
        candidate.privilege_type
      )
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner can access an excluded authority relation'
      USING ERRCODE = '55000';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       owner_oid,
       'public.schema_migrations',
       'SELECT'
     ) OR pg_catalog.has_table_privilege(
       owner_oid,
       'public.schema_migrations',
       'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) THEN
    RAISE EXCEPTION 'general-app runtime migration-ledger privilege is not SELECT-only'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'budget_account_opening_evidence',
        'budget_accounts',
        'budget_control_cutovers',
        'budget_cost_event_outbox',
        'budget_reservation_allocations',
        'budget_reservation_transitions',
        'budget_reservations',
        'budget_rule_revisions',
        'budget_usage_ledger',
        'pylva_budget_authority_order_seq',
        'schema_migrations',
        '_048_api_keys_scope_backup'
      )
      AND relation.relowner = owner_oid
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner reached an excluded relation'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
    CROSS JOIN LATERAL (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES'))
      AS candidate(privilege_type)
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'schema_migrations'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.has_column_privilege(
        owner_oid,
        relation.oid,
        attribute.attnum,
        candidate.privilege_type
      )
  ) THEN
    RAISE EXCEPTION 'general-app runtime migration-ledger column privilege is not read-only'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
    CROSS JOIN LATERAL (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
    ) AS candidate(privilege_type)
    WHERE namespace.nspname = 'public'
      AND relation.relname IN (
        'budget_account_opening_evidence',
        'budget_accounts',
        'budget_control_cutovers',
        'budget_cost_event_outbox',
        'budget_reservation_allocations',
        'budget_reservation_transitions',
        'budget_reservations',
        'budget_rule_revisions',
        'budget_usage_ledger',
        '_048_api_keys_scope_backup'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.has_column_privilege(
        owner_oid,
        relation.oid,
        attribute.attnum,
        candidate.privilege_type
      )
  ) THEN
    RAISE EXCEPTION 'general-app runtime owner can access an authority column'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.has_function_privilege(
       owner_oid,
       'public.pylva_budget_projection_actionable_builders(uuid,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       owner_oid,
       'public.pylva_budget_expiry_actionable_builders(uuid,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'general-app runtime owner can execute a budget discovery function'
      USING ERRCODE = '55000';
  END IF;
END;
$final_contract$;
