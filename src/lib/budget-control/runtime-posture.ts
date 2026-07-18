import type { Sql } from 'postgres';
import { env } from '../config.js';
import { getBudgetControlClientMetadata, getBudgetControlSql } from './client.js';
import { BudgetControlDatabaseConfigError } from './database-config.js';

export type BudgetControlRuntimePostureReason =
  | 'attestation_query_failed'
  | 'credential_invalid'
  | 'credential_isolation_failed'
  | 'credential_missing'
  | 'dangerous_role_membership'
  | 'invalid_attestation'
  | 'missing_expiry_discovery_execute'
  | 'missing_projection_discovery_execute'
  | 'missing_runtime_membership'
  | 'protected_object_ownership'
  | 'row_security_disabled'
  | 'schema_incomplete'
  | 'unsafe_discovery_function'
  | 'unsafe_login_acl'
  | 'unsafe_login_role'
  | 'unsafe_runtime_acl'
  | 'unsafe_runtime_role';

export type BudgetControlProductionPosture =
  | {
      ready: true;
      reason: null;
      attested: boolean;
      credential_source: 'dedicated' | 'local_ci_fallback';
    }
  | {
      ready: false;
      reason: BudgetControlRuntimePostureReason;
      attested: false;
      credential_source: null;
    };

export interface BudgetControlRuntimeAttestationRow {
  current_user_matches_login: unknown;
  login_role_safe: unknown;
  runtime_role_safe: unknown;
  has_runtime_membership: unknown;
  has_no_dangerous_membership: unknown;
  login_acl_safe: unknown;
  runtime_acl_safe: unknown;
  owns_no_protected_relations: unknown;
  protected_relations_complete: unknown;
  protected_relations_rls_enabled: unknown;
  authoritative_relations_force_rls: unknown;
  legacy_relations_not_force_rls: unknown;
  row_security_on: unknown;
  discovery_functions_safe: unknown;
  projection_discovery_executable: unknown;
  expiry_discovery_executable: unknown;
}

const RUNTIME_ATTESTATION_SQL = `
WITH RECURSIVE
login_role AS (
  SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
         role.rolbypassrls, role.rolcreatedb, role.rolcreaterole,
         role.rolreplication
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = SESSION_USER
),
runtime_role AS (
  SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
         role.rolbypassrls, role.rolcreatedb, role.rolcreaterole,
         role.rolreplication
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = 'pylva_budget_control_runtime'
),
reachable_roles(role_oid) AS (
  SELECT login.oid
  FROM login_role AS login
  UNION
  SELECT membership.roleid
  FROM pg_catalog.pg_auth_members AS membership
  JOIN reachable_roles AS reachable
    ON reachable.role_oid = membership.member
),
discovery_functions AS (
  SELECT
    pg_catalog.to_regprocedure(
      'public.pylva_budget_projection_actionable_builders(uuid,integer)'
    )::pg_catalog.oid AS projection_oid,
    pg_catalog.to_regprocedure(
      'public.pylva_budget_expiry_actionable_builders(uuid,integer)'
    )::pg_catalog.oid AS expiry_oid
),
definer_roles AS (
  SELECT procedure.proowner AS role_oid
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN discovery_functions AS discovery
  WHERE procedure.oid = discovery.projection_oid
     OR procedure.oid = discovery.expiry_oid
),
protected_relations AS (
  SELECT relation.oid,
         relation.relname,
         relation.relowner,
         relation.relacl,
         relation.relrowsecurity,
         relation.relforcerowsecurity
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND relation.relname = ANY (ARRAY[
      'builders',
      'rules',
      'cost_sources',
      'custom_pricing',
      'budget_account_opening_evidence',
      'budget_accounts',
      'budget_control_cutovers',
      'budget_cost_event_outbox',
      'budget_reservation_allocations',
      'budget_reservation_transitions',
      'budget_reservations',
      'budget_rule_revisions',
      'budget_usage_ledger'
    ]::pg_catalog.text[])
),
expected_runtime_relation_acl AS (
  SELECT expected.relation_name,
         pg_catalog.unnest(expected.privileges) AS privilege_type
  FROM (VALUES
    ('budget_account_opening_evidence', ARRAY['INSERT', 'SELECT']::pg_catalog.text[]),
    ('budget_accounts', ARRAY['INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[]),
    ('budget_control_cutovers', ARRAY['INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[]),
    ('budget_cost_event_outbox', ARRAY['INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[]),
    ('budget_reservation_allocations', ARRAY['INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[]),
    ('budget_reservation_transitions', ARRAY['INSERT', 'SELECT']::pg_catalog.text[]),
    ('budget_reservations', ARRAY['INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[]),
    ('budget_rule_revisions', ARRAY['INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[]),
    ('budget_usage_ledger', ARRAY['INSERT', 'SELECT']::pg_catalog.text[]),
    ('builders', ARRAY['SELECT']::pg_catalog.text[]),
    ('cost_sources', ARRAY['SELECT']::pg_catalog.text[]),
    ('custom_pricing', ARRAY['SELECT']::pg_catalog.text[]),
    ('llm_pricing', ARRAY['SELECT']::pg_catalog.text[]),
    ('rules', ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::pg_catalog.text[])
  ) AS expected(relation_name, privileges)
),
runtime_relation_acl AS (
  SELECT namespace.nspname AS schema_name,
         relation.relname AS relation_name,
         privilege.privilege_type,
         privilege.is_grantable
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND privilege.grantee = runtime.oid
),
runtime_column_acl AS (
  SELECT privilege.is_grantable
  FROM pg_catalog.pg_attribute AS attribute
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
  WHERE attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND privilege.grantee = runtime.oid
),
runtime_sequence_acl AS (
  SELECT namespace.nspname AS schema_name,
         sequence.relname AS sequence_name,
         privilege.privilege_type,
         privilege.is_grantable
  FROM pg_catalog.pg_class AS sequence
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = sequence.relnamespace
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(sequence.relacl) AS privilege
  WHERE sequence.relkind = 'S'
    AND privilege.grantee = runtime.oid
),
expected_runtime_function_acl AS (
  SELECT discovery.projection_oid AS function_oid, 'EXECUTE'::pg_catalog.text AS privilege_type
  FROM discovery_functions AS discovery
  UNION ALL
  SELECT discovery.expiry_oid AS function_oid, 'EXECUTE'::pg_catalog.text AS privilege_type
  FROM discovery_functions AS discovery
),
runtime_function_acl AS (
  SELECT procedure.oid AS function_oid,
         privilege.privilege_type,
         privilege.is_grantable
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
  WHERE privilege.grantee = runtime.oid
),
runtime_schema_acl AS (
  SELECT namespace.nspname AS schema_name,
         privilege.privilege_type,
         privilege.is_grantable
  FROM pg_catalog.pg_namespace AS namespace
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
  WHERE privilege.grantee = runtime.oid
),
runtime_database_acl AS (
  SELECT database.datname AS database_name,
         privilege.privilege_type,
         privilege.is_grantable
  FROM pg_catalog.pg_database AS database
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
  WHERE privilege.grantee = runtime.oid
),
runtime_acl_contract AS (
  SELECT
    NOT EXISTS (
      SELECT 'public'::pg_catalog.name, expected.relation_name, expected.privilege_type
      FROM expected_runtime_relation_acl AS expected
      EXCEPT
      SELECT actual.schema_name, actual.relation_name, actual.privilege_type
      FROM runtime_relation_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.schema_name, actual.relation_name, actual.privilege_type
      FROM runtime_relation_acl AS actual
      EXCEPT
      SELECT 'public'::pg_catalog.name, expected.relation_name, expected.privilege_type
      FROM expected_runtime_relation_acl AS expected
    )
    AND NOT EXISTS (
      SELECT 1 FROM runtime_relation_acl AS actual WHERE actual.is_grantable
    )
    AND NOT EXISTS (SELECT 1 FROM runtime_column_acl)
    AND NOT EXISTS (
      SELECT 'public'::pg_catalog.name,
             'pylva_budget_authority_order_seq'::pg_catalog.name,
             'USAGE'::pg_catalog.text
      EXCEPT
      SELECT actual.schema_name, actual.sequence_name, actual.privilege_type
      FROM runtime_sequence_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.schema_name, actual.sequence_name, actual.privilege_type
      FROM runtime_sequence_acl AS actual
      EXCEPT
      SELECT 'public'::pg_catalog.name,
             'pylva_budget_authority_order_seq'::pg_catalog.name,
             'USAGE'::pg_catalog.text
    )
    AND NOT EXISTS (
      SELECT 1 FROM runtime_sequence_acl AS actual WHERE actual.is_grantable
    )
    AND NOT EXISTS (
      SELECT expected.function_oid, expected.privilege_type
      FROM expected_runtime_function_acl AS expected
      EXCEPT
      SELECT actual.function_oid, actual.privilege_type
      FROM runtime_function_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.function_oid, actual.privilege_type
      FROM runtime_function_acl AS actual
      EXCEPT
      SELECT expected.function_oid, expected.privilege_type
      FROM expected_runtime_function_acl AS expected
    )
    AND NOT EXISTS (
      SELECT 1 FROM runtime_function_acl AS actual WHERE actual.is_grantable
    )
    AND NOT EXISTS (
      SELECT 'public'::pg_catalog.name, 'USAGE'::pg_catalog.text
      EXCEPT
      SELECT actual.schema_name, actual.privilege_type
      FROM runtime_schema_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.schema_name, actual.privilege_type
      FROM runtime_schema_acl AS actual
      EXCEPT
      SELECT 'public'::pg_catalog.name, 'USAGE'::pg_catalog.text
    )
    AND NOT EXISTS (
      SELECT 1 FROM runtime_schema_acl AS actual WHERE actual.is_grantable
    )
    AND NOT EXISTS (
      SELECT pg_catalog.current_database(), 'CONNECT'::pg_catalog.text
      EXCEPT
      SELECT actual.database_name, actual.privilege_type
      FROM runtime_database_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.database_name, actual.privilege_type
      FROM runtime_database_acl AS actual
      EXCEPT
      SELECT pg_catalog.current_database(), 'CONNECT'::pg_catalog.text
    )
    AND NOT EXISTS (
      SELECT 1 FROM runtime_database_acl AS actual WHERE actual.is_grantable
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN runtime_role AS runtime
      WHERE relation.relowner = runtime.oid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN runtime_role AS runtime
      WHERE procedure.proowner = runtime.oid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND privilege.grantee = 0
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS sequence
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = sequence.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(sequence.relacl) AS privilege
      WHERE namespace.nspname = 'public'
        AND sequence.relkind = 'S'
        AND privilege.grantee = 0
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      WHERE namespace.nspname = 'public'
        AND privilege.grantee = 0
        AND privilege.privilege_type = 'CREATE'
    ) AS safe
),
discovery_owner_roles AS (
  SELECT role.oid, role.rolname
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname IN (
    'pylva_budget_projection_discovery_owner',
    'pylva_budget_expiry_discovery_owner'
  )
),
expected_discovery_owner_column_acl AS (
  SELECT *
  FROM (VALUES
    ('pylva_budget_projection_discovery_owner', 'budget_cost_event_outbox', 'attempts', 'SELECT'),
    ('pylva_budget_projection_discovery_owner', 'budget_cost_event_outbox', 'available_at', 'SELECT'),
    ('pylva_budget_projection_discovery_owner', 'budget_cost_event_outbox', 'builder_id', 'SELECT'),
    ('pylva_budget_projection_discovery_owner', 'budget_cost_event_outbox', 'lock_expires_at', 'SELECT'),
    ('pylva_budget_projection_discovery_owner', 'budget_cost_event_outbox', 'projection_verified_at', 'SELECT'),
    ('pylva_budget_projection_discovery_owner', 'budget_cost_event_outbox', 'status', 'SELECT'),
    ('pylva_budget_expiry_discovery_owner', 'budget_reservations', 'builder_id', 'SELECT'),
    ('pylva_budget_expiry_discovery_owner', 'budget_reservations', 'decision', 'SELECT'),
    ('pylva_budget_expiry_discovery_owner', 'budget_reservations', 'expires_at', 'SELECT'),
    ('pylva_budget_expiry_discovery_owner', 'budget_reservations', 'state', 'SELECT')
  ) AS expected(owner_name, relation_name, column_name, privilege_type)
),
effective_discovery_owner_column_acl AS (
  SELECT owner.rolname AS owner_name,
         relation.relname AS relation_name,
         attribute.attname AS column_name,
         candidate.privilege_type
  FROM discovery_owner_roles AS owner
  CROSS JOIN pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = relation.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
    AS candidate(privilege_type)
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND pg_catalog.has_column_privilege(
      owner.oid,
      relation.oid,
      attribute.attnum,
      candidate.privilege_type
    )
),
direct_discovery_owner_schema_acl AS (
  SELECT owner.rolname AS owner_name,
         namespace.nspname AS schema_name,
         privilege.privilege_type,
         privilege.is_grantable
  FROM discovery_owner_roles AS owner
  CROSS JOIN pg_catalog.pg_namespace AS namespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
  WHERE privilege.grantee = owner.oid
),
discovery_owner_acl_contract AS (
  SELECT
    (SELECT pg_catalog.count(*) FROM discovery_owner_roles) = 2
    AND NOT EXISTS (
      SELECT expected.owner_name,
             expected.relation_name,
             expected.column_name,
             expected.privilege_type
      FROM expected_discovery_owner_column_acl AS expected
      EXCEPT
      SELECT actual.owner_name,
             actual.relation_name,
             actual.column_name,
             actual.privilege_type
      FROM effective_discovery_owner_column_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.owner_name,
             actual.relation_name,
             actual.column_name,
             actual.privilege_type
      FROM effective_discovery_owner_column_acl AS actual
      EXCEPT
      SELECT expected.owner_name,
             expected.relation_name,
             expected.column_name,
             expected.privilege_type
      FROM expected_discovery_owner_column_acl AS expected
    )
    AND NOT EXISTS (
      SELECT 1
      FROM discovery_owner_roles AS owner
      CROSS JOIN pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN (VALUES
        ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
        ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
      ) AS candidate(privilege_type)
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_table_privilege(
          owner.oid,
          relation.oid,
          candidate.privilege_type
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM discovery_owner_roles AS owner
      CROSS JOIN pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
        AS candidate(privilege_type)
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p')
        AND pg_catalog.has_column_privilege(
          owner.oid,
          relation.oid,
          attribute.attnum,
          candidate.privilege_type || ' WITH GRANT OPTION'
        )
    )
    AND NOT EXISTS (
      SELECT expected.owner_name, 'public'::pg_catalog.name, 'USAGE'::pg_catalog.text
      FROM (
        VALUES
          ('pylva_budget_projection_discovery_owner'),
          ('pylva_budget_expiry_discovery_owner')
      ) AS expected(owner_name)
      EXCEPT
      SELECT actual.owner_name, actual.schema_name, actual.privilege_type
      FROM direct_discovery_owner_schema_acl AS actual
    )
    AND NOT EXISTS (
      SELECT actual.owner_name, actual.schema_name, actual.privilege_type
      FROM direct_discovery_owner_schema_acl AS actual
      EXCEPT
      SELECT expected.owner_name, 'public'::pg_catalog.name, 'USAGE'::pg_catalog.text
      FROM (
        VALUES
          ('pylva_budget_projection_discovery_owner'),
          ('pylva_budget_expiry_discovery_owner')
      ) AS expected(owner_name)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM direct_discovery_owner_schema_acl AS actual
      WHERE actual.is_grantable
    ) AS safe
),
discovery_function_contract AS (
  SELECT
    pg_catalog.count(*) = 2
    AND pg_catalog.count(DISTINCT procedure.proowner) = 2
    AND COALESCE(pg_catalog.bool_and(
      procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.prokind = 'f'
      AND NOT procedure.proisstrict
      AND procedure.proparallel = 'u'
      AND procedure.proretset
      -- PostgreSQL catalogs a one-column RETURNS TABLE(builder_id uuid) as
      -- SETOF uuid (while pg_get_function_result retains the TABLE shape).
      AND procedure.prorettype = 'pg_catalog.uuid'::pg_catalog.regtype
      AND pg_catalog.pg_get_function_result(procedure.oid) = 'TABLE(builder_id uuid)'
      AND language.lanname = 'plpgsql'
      AND procedure.proconfig = ARRAY['search_path=pg_catalog']::pg_catalog.text[]
      AND (
        (procedure.oid = discovery.projection_oid
          AND owner.rolname = 'pylva_budget_projection_discovery_owner')
        OR
        (procedure.oid = discovery.expiry_oid
          AND owner.rolname = 'pylva_budget_expiry_discovery_owner')
      )
      AND NOT owner.rolcanlogin
      AND NOT owner.rolinherit
      AND NOT owner.rolsuper
      AND NOT owner.rolbypassrls
      AND NOT owner.rolcreatedb
      AND NOT owner.rolcreaterole
      AND NOT owner.rolreplication
      AND NOT pg_catalog.has_schema_privilege(owner.oid, 'public', 'CREATE')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.member = owner.oid
      )
      AND 1 = (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_auth_members AS membership
        WHERE membership.roleid = owner.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS creator
          ON creator.oid = membership.member
        WHERE membership.roleid = owner.oid
          AND (
            NOT membership.admin_option
            OR membership.inherit_option
            OR membership.set_option
            OR NOT creator.rolcreaterole
            OR creator.rolsuper
            OR creator.rolbypassrls
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM protected_relations AS relation
        WHERE relation.relowner = owner.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee NOT IN (procedure.proowner, runtime.oid)
      )
      AND 2 = (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS privilege
        WHERE privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee IN (procedure.proowner, runtime.oid)
          AND NOT privilege.is_grantable
      )
    ), FALSE) AS safe
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_roles AS owner
    ON owner.oid = procedure.proowner
  JOIN pg_catalog.pg_language AS language
    ON language.oid = procedure.prolang
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN discovery_functions AS discovery
  WHERE procedure.oid = discovery.projection_oid
     OR procedure.oid = discovery.expiry_oid
  HAVING COALESCE((SELECT contract.safe FROM discovery_owner_acl_contract AS contract), FALSE)
),
login_acl_contract AS (
  SELECT
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
      WHERE privilege.grantee = login.oid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
      WHERE privilege.grantee = login.oid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      WHERE privilege.grantee = login.oid
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database AS database
      CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
      WHERE privilege.grantee = login.oid
        AND (
          database.datname <> pg_catalog.current_database()
          OR privilege.privilege_type <> 'CONNECT'
          OR privilege.is_grantable
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.relowner = login.oid
        AND relation.relpersistence <> 't'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.proowner = login.oid
    ) AS safe
  FROM login_role AS login
)
SELECT
  CURRENT_USER = SESSION_USER AS current_user_matches_login,
  COALESCE((
    SELECT login.rolcanlogin
       AND login.rolinherit
       AND NOT login.rolsuper
       AND NOT login.rolbypassrls
       AND NOT login.rolcreatedb
       AND NOT login.rolcreaterole
       AND NOT login.rolreplication
    FROM login_role AS login
  ), FALSE) AS login_role_safe,
  COALESCE((
    SELECT NOT runtime.rolcanlogin
       AND NOT runtime.rolinherit
       AND NOT runtime.rolsuper
       AND NOT runtime.rolbypassrls
       AND NOT runtime.rolcreatedb
       AND NOT runtime.rolcreaterole
       AND NOT runtime.rolreplication
    FROM runtime_role AS runtime
  ), FALSE) AS runtime_role_safe,
  EXISTS (
    SELECT 1
    FROM reachable_roles AS reachable
    JOIN runtime_role AS runtime ON runtime.oid = reachable.role_oid
  ) AS has_runtime_membership,
  NOT EXISTS (
    SELECT 1
    FROM reachable_roles AS reachable
    JOIN pg_catalog.pg_roles AS role ON role.oid = reachable.role_oid
    WHERE role.rolsuper
       OR role.rolbypassrls
       OR reachable.role_oid IN (SELECT definer.role_oid FROM definer_roles AS definer)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM reachable_roles AS reachable
    CROSS JOIN login_role AS login
    CROSS JOIN runtime_role AS runtime
    WHERE reachable.role_oid NOT IN (login.oid, runtime.oid)
  ) AS has_no_dangerous_membership,
  COALESCE((
    SELECT contract.safe
    FROM login_acl_contract AS contract
  ), FALSE) AS login_acl_safe,
  COALESCE((
    SELECT contract.safe
    FROM runtime_acl_contract AS contract
  ), FALSE) AS runtime_acl_safe,
  NOT EXISTS (
    SELECT 1
    FROM protected_relations AS relation
    JOIN reachable_roles AS reachable ON reachable.role_oid = relation.relowner
  ) AS owns_no_protected_relations,
  (SELECT pg_catalog.count(*) FROM protected_relations) = 13 AS protected_relations_complete,
  COALESCE((
    SELECT pg_catalog.bool_and(relation.relrowsecurity)
    FROM protected_relations AS relation
  ), FALSE) AS protected_relations_rls_enabled,
  COALESCE((
    SELECT pg_catalog.count(*) = 9
       AND pg_catalog.bool_and(relation.relforcerowsecurity)
    FROM protected_relations AS relation
    WHERE relation.relname = ANY (ARRAY[
      'budget_account_opening_evidence',
      'budget_accounts',
      'budget_control_cutovers',
      'budget_cost_event_outbox',
      'budget_reservation_allocations',
      'budget_reservation_transitions',
      'budget_reservations',
      'budget_rule_revisions',
      'budget_usage_ledger'
    ]::pg_catalog.text[])
  ), FALSE) AS authoritative_relations_force_rls,
  COALESCE((
    SELECT pg_catalog.count(*) = 4
       AND pg_catalog.bool_and(NOT relation.relforcerowsecurity)
    FROM protected_relations AS relation
    WHERE relation.relname = ANY (ARRAY[
      'builders',
      'rules',
      'cost_sources',
      'custom_pricing'
    ]::pg_catalog.text[])
  ), FALSE) AS legacy_relations_not_force_rls,
  pg_catalog.current_setting('row_security', TRUE) = 'on' AS row_security_on,
  COALESCE((
    SELECT contract.safe
    FROM discovery_function_contract AS contract
  ), FALSE) AS discovery_functions_safe,
  COALESCE((
    SELECT discovery.projection_oid IS NOT NULL
       AND pg_catalog.has_function_privilege(
         SESSION_USER,
         discovery.projection_oid,
         'EXECUTE'
       )
    FROM discovery_functions AS discovery
  ), FALSE) AS projection_discovery_executable,
  COALESCE((
    SELECT discovery.expiry_oid IS NOT NULL
       AND pg_catalog.has_function_privilege(
         SESSION_USER,
         discovery.expiry_oid,
         'EXECUTE'
       )
    FROM discovery_functions AS discovery
  ), FALSE) AS expiry_discovery_executable
`;

function strictBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Convert one catalog attestation row into a stable, non-secret posture. */
export function evaluateBudgetControlRuntimeAttestation(
  rows: readonly BudgetControlRuntimeAttestationRow[],
): BudgetControlRuntimePostureReason | null {
  if (rows.length !== 1) return 'invalid_attestation';
  const row = rows[0]!;
  const values = {
    currentUserMatchesLogin: strictBoolean(row.current_user_matches_login),
    loginRoleSafe: strictBoolean(row.login_role_safe),
    runtimeRoleSafe: strictBoolean(row.runtime_role_safe),
    hasRuntimeMembership: strictBoolean(row.has_runtime_membership),
    hasNoDangerousMembership: strictBoolean(row.has_no_dangerous_membership),
    loginAclSafe: strictBoolean(row.login_acl_safe),
    runtimeAclSafe: strictBoolean(row.runtime_acl_safe),
    ownsNoProtectedRelations: strictBoolean(row.owns_no_protected_relations),
    protectedRelationsComplete: strictBoolean(row.protected_relations_complete),
    protectedRelationsRlsEnabled: strictBoolean(row.protected_relations_rls_enabled),
    authoritativeRelationsForceRls: strictBoolean(row.authoritative_relations_force_rls),
    legacyRelationsNotForceRls: strictBoolean(row.legacy_relations_not_force_rls),
    rowSecurityOn: strictBoolean(row.row_security_on),
    discoveryFunctionsSafe: strictBoolean(row.discovery_functions_safe),
    projectionDiscoveryExecutable: strictBoolean(row.projection_discovery_executable),
    expiryDiscoveryExecutable: strictBoolean(row.expiry_discovery_executable),
  };
  if (Object.values(values).some((value) => value === null)) return 'invalid_attestation';
  if (!values.currentUserMatchesLogin || !values.loginRoleSafe) return 'unsafe_login_role';
  if (!values.runtimeRoleSafe) return 'unsafe_runtime_role';
  if (!values.hasRuntimeMembership) return 'missing_runtime_membership';
  if (!values.hasNoDangerousMembership) return 'dangerous_role_membership';
  if (!values.loginAclSafe) return 'unsafe_login_acl';
  if (!values.runtimeAclSafe) return 'unsafe_runtime_acl';
  if (!values.ownsNoProtectedRelations) return 'protected_object_ownership';
  if (!values.protectedRelationsComplete) return 'schema_incomplete';
  if (
    !values.protectedRelationsRlsEnabled ||
    !values.authoritativeRelationsForceRls ||
    !values.legacyRelationsNotForceRls ||
    !values.rowSecurityOn
  ) {
    return 'row_security_disabled';
  }
  if (!values.discoveryFunctionsSafe) return 'unsafe_discovery_function';
  if (!values.projectionDiscoveryExecutable) return 'missing_projection_discovery_execute';
  if (!values.expiryDiscoveryExecutable) return 'missing_expiry_discovery_execute';
  return null;
}

export async function attestBudgetControlRuntime(
  client: Sql,
): Promise<BudgetControlRuntimePostureReason | null> {
  const rows = await client.unsafe<BudgetControlRuntimeAttestationRow[]>(RUNTIME_ATTESTATION_SQL);
  return evaluateBudgetControlRuntimeAttestation(rows);
}

function configFailureReason(
  error: BudgetControlDatabaseConfigError,
): BudgetControlRuntimePostureReason {
  if (error.code === 'missing_url') return 'credential_missing';
  if (error.code === 'credential_exposure' || error.code === 'credential_reuse') {
    return 'credential_isolation_failed';
  }
  return 'credential_invalid';
}

async function inspectProductionPosture(): Promise<BudgetControlProductionPosture> {
  let metadata: ReturnType<typeof getBudgetControlClientMetadata>;
  let client: Sql;
  try {
    metadata = getBudgetControlClientMetadata();
    client = getBudgetControlSql();
  } catch (error) {
    return {
      ready: false,
      reason:
        error instanceof BudgetControlDatabaseConfigError
          ? configFailureReason(error)
          : 'credential_invalid',
      attested: false,
      credential_source: null,
    };
  }

  if (env.NODE_ENV !== 'production') {
    return {
      ready: true,
      reason: null,
      attested: false,
      credential_source: metadata.source,
    };
  }

  try {
    const reason = await attestBudgetControlRuntime(client);
    if (reason !== null) {
      return { ready: false, reason, attested: false, credential_source: null };
    }
  } catch {
    return {
      ready: false,
      reason: 'attestation_query_failed',
      attested: false,
      credential_source: null,
    };
  }

  return {
    ready: true,
    reason: null,
    attested: true,
    credential_source: metadata.source,
  };
}

let posturePromise: Promise<BudgetControlProductionPosture> | undefined;

export function getBudgetControlProductionPosture(): Promise<BudgetControlProductionPosture> {
  if (!posturePromise) {
    posturePromise = inspectProductionPosture().then((posture) => {
      // A transient startup/database failure may recover and should be
      // re-attested. Deterministic role/config failures remain sticky until a
      // process restart, which prevents request-by-request probing.
      if (!posture.ready && posture.reason === 'attestation_query_failed') {
        posturePromise = undefined;
      }
      return posture;
    });
  }
  return posturePromise;
}

export class BudgetControlRuntimeNotReadyError extends Error {
  readonly reason: BudgetControlRuntimePostureReason;
  readonly status = 503 as const;
  readonly code = 'INTERNAL_ERROR' as const;

  constructor(reason: BudgetControlRuntimePostureReason) {
    super(`authoritative budget-control runtime posture is not ready (${reason})`);
    this.name = 'BudgetControlRuntimeNotReadyError';
    this.reason = reason;
  }
}

export async function assertBudgetControlRuntimeReady(): Promise<void> {
  const posture = await getBudgetControlProductionPosture();
  if (!posture.ready) throw new BudgetControlRuntimeNotReadyError(posture.reason);
}

/**
 * Production boot gate. Rule mutations and lifecycle workers use the
 * authoritative pool even while new reservations are disabled, so the
 * dedicated credential is a deployment prerequisite rather than a feature-
 * flag dependency.
 */
export async function assertBudgetControlRuntimeReadyForProduction(): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  await assertBudgetControlRuntimeReady();
}

/** Default path for every authoritative mutation, projection, and expiry call. */
export async function getReadyBudgetControlSql(): Promise<Sql> {
  await assertBudgetControlRuntimeReady();
  return getBudgetControlSql();
}

export function _resetBudgetControlRuntimePostureForTests(): void {
  posturePromise = undefined;
}
