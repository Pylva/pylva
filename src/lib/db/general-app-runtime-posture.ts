import type { Sql } from 'postgres';
import { env } from '../config.js';
import { sql } from './client.js';

export type GeneralAppRuntimePostureReason =
  | 'ambient_access_missing'
  | 'attestation_query_failed'
  | 'authority_access_exposed'
  | 'identity_mismatch'
  | 'invalid_attestation'
  | 'legacy_access_missing'
  | 'migration_ledger_access_invalid'
  | 'unsafe_login_acl'
  | 'unsafe_login_ownership'
  | 'unsafe_login_role'
  | 'unsafe_membership_graph'
  | 'unsafe_runtime_ownership'
  | 'unsafe_runtime_role';

export type GeneralAppProductionPosture =
  | { ready: true; reason: null; attested: boolean }
  | {
      ready: false;
      reason: GeneralAppRuntimePostureReason;
      attested: false;
    };

export interface GeneralAppRuntimeAttestationRow {
  ambient_access_ready: unknown;
  authority_access_denied: unknown;
  current_user_matches_login: unknown;
  legacy_crud_available: unknown;
  login_direct_acl_safe: unknown;
  login_ownership_safe: unknown;
  login_role_safe: unknown;
  membership_graph_safe: unknown;
  runtime_ownership_safe: unknown;
  runtime_role_safe: unknown;
  schema_migrations_select_only: unknown;
}

const GENERAL_APP_RUNTIME_ATTESTATION_SQL = `
WITH
login_role AS (
  SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
         role.rolcreatedb, role.rolcreaterole, role.rolreplication,
         role.rolbypassrls
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = SESSION_USER
),
runtime_role AS (
  SELECT role.oid, role.rolcanlogin, role.rolinherit, role.rolsuper,
         role.rolcreatedb, role.rolcreaterole, role.rolreplication,
         role.rolbypassrls
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = 'pylva_general_app_runtime'
),
runtime_migrator AS (
  SELECT member.oid
  FROM pg_catalog.pg_auth_members AS edge
  JOIN runtime_role AS runtime ON runtime.oid = edge.roleid
  JOIN login_role AS login ON login.oid <> edge.member
  JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
  WHERE member.rolcanlogin
    AND member.rolinherit
    AND member.rolcreaterole
    AND NOT member.rolsuper
    AND NOT member.rolreplication
    AND NOT member.rolbypassrls
    AND NOT edge.inherit_option
    AND (
      (edge.admin_option AND NOT edge.set_option)
      OR (NOT edge.admin_option AND edge.set_option)
    )
  GROUP BY member.oid
  HAVING pg_catalog.count(*) = 2
    AND pg_catalog.count(*) FILTER (
      WHERE edge.admin_option AND NOT edge.set_option
    ) = 1
    AND pg_catalog.count(*) FILTER (
      WHERE NOT edge.admin_option AND edge.set_option
    ) = 1
),
expected_runtime_relations(schema_name, relation_name, relation_kind) AS (
  VALUES
    ('public'::pg_catalog.name, 'alert_history'::pg_catalog.name, 'r'::"char"),
    ('public', 'anomaly_events', 'r'::"char"),
    ('public', 'api_key_vault', 'r'::"char"),
    ('public', 'api_key_vault_id_seq', 'S'::"char"),
    ('public', 'api_keys', 'r'::"char"),
    ('public', 'audit_log', 'p'::"char"),
    ('public', 'audit_log_id_seq', 'S'::"char"),
    ('public', 'builder_alert_config', 'r'::"char"),
    ('public', 'builder_feature_flags', 'r'::"char"),
    ('public', 'builders', 'r'::"char"),
    ('public', 'cost_sources', 'r'::"char"),
    ('public', 'custom_pricing', 'r'::"char"),
    ('public', 'custom_rule_requests', 'r'::"char"),
    ('public', 'customer_pricing', 'r'::"char"),
    ('public', 'customers', 'r'::"char"),
    ('public', 'feature_flag_overrides', 'r'::"char"),
    ('public', 'invites', 'r'::"char"),
    ('public', 'invoice_idempotency', 'r'::"char"),
    ('public', 'invoices', 'r'::"char"),
    ('public', 'llm_pricing', 'r'::"char"),
    ('public', 'llm_pricing_id_seq', 'S'::"char"),
    ('public', 'portal_access_grants', 'r'::"char"),
    ('public', 'portal_configs', 'r'::"char"),
    ('public', 'portal_domains', 'r'::"char"),
    ('public', 'portal_links', 'r'::"char"),
    ('public', 'portal_sessions', 'r'::"char"),
    ('public', 'pricing_onboarding_tasks', 'r'::"char"),
    ('public', 'pricing_sync_log', 'r'::"char"),
    ('public', 'rule_alert_channels', 'r'::"char"),
    ('public', 'rule_events', 'r'::"char"),
    ('public', 'rules', 'r'::"char"),
    ('public', 'stripe_connect', 'r'::"char"),
    ('public', 'stripe_connect_event_log', 'r'::"char"),
    ('public', 'user_builder_memberships', 'r'::"char"),
    ('public', 'users', 'r'::"char"),
    ('public', 'webhook_configs', 'r'::"char"),
    ('public', 'webhook_configs_with_grace', 'v'::"char"),
    ('public', 'webhook_dlq', 'r'::"char")
),
audit_partitions AS (
  SELECT child_namespace.nspname AS schema_name,
         child.relname AS relation_name,
         child.relkind AS relation_kind
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
),
complete_expected_runtime_relations AS (
  SELECT * FROM expected_runtime_relations
  UNION ALL
  SELECT * FROM audit_partitions
),
actual_runtime_relations AS (
  SELECT namespace.nspname AS schema_name,
         relation.relname AS relation_name,
         relation.relkind AS relation_kind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN runtime_role AS runtime ON runtime.oid = relation.relowner
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
authority_relations AS (
  SELECT relation.oid, relation.relkind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
    AND relation.relname = ANY (ARRAY[
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
excluded_backup AS (
  SELECT relation.oid, relation.relkind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = '_048_api_keys_scope_backup'
    AND relation.relkind = 'r'
),
authority_sequence AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'pylva_budget_authority_order_seq'
    AND relation.relkind = 'S'
),
schema_migrations_relation AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'schema_migrations'
    AND relation.relkind = 'r'
),
legacy_crud_relations AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relname = ANY (ARRAY[
      'builders',
      'user_builder_memberships'
    ]::pg_catalog.text[])
    AND relation.relkind = 'r'
),
discovery_functions AS (
  SELECT
    pg_catalog.to_regprocedure(
      'public.pylva_budget_projection_actionable_builders(uuid,integer)'
    )::pg_catalog.oid AS projection_oid,
    pg_catalog.to_regprocedure(
      'public.pylva_budget_expiry_actionable_builders(uuid,integer)'
    )::pg_catalog.oid AS expiry_oid
)
SELECT
  CURRENT_USER = SESSION_USER AS current_user_matches_login,
  COALESCE((
    SELECT login.rolcanlogin
       AND login.rolinherit
       AND NOT login.rolsuper
       AND NOT login.rolcreatedb
       AND NOT login.rolcreaterole
       AND NOT login.rolreplication
       AND NOT login.rolbypassrls
    FROM login_role AS login
  ), FALSE) AS login_role_safe,
  COALESCE((
    SELECT NOT runtime.rolcanlogin
       AND NOT runtime.rolinherit
       AND NOT runtime.rolsuper
       AND NOT runtime.rolcreatedb
       AND NOT runtime.rolcreaterole
       AND NOT runtime.rolreplication
       AND NOT runtime.rolbypassrls
    FROM runtime_role AS runtime
  ), FALSE) AS runtime_role_safe,
  COALESCE((
    SELECT
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_database AS database
        WHERE database.datdba = runtime.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspowner = runtime.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_default_acl AS default_acl
        WHERE default_acl.defaclrole = runtime.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_acl
        CROSS JOIN LATERAL
          pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
        WHERE privilege.grantee = runtime.oid
      )
      AND NOT EXISTS (
        SELECT schema_name, relation_name, relation_kind
        FROM complete_expected_runtime_relations
        EXCEPT
        SELECT schema_name, relation_name, relation_kind
        FROM actual_runtime_relations
      )
      AND NOT EXISTS (
        SELECT schema_name, relation_name, relation_kind
        FROM actual_runtime_relations
        EXCEPT
        SELECT schema_name, relation_name, relation_kind
        FROM complete_expected_runtime_relations
      )
      AND (
        SELECT pg_catalog.count(*) = 2
        FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.proowner = runtime.oid
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.proowner = runtime.oid
          AND procedure.oid = pg_catalog.to_regprocedure(
            'public.generate_slug(text)'
          )
      )
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.proowner = runtime.oid
          AND procedure.oid = pg_catalog.to_regprocedure(
            'public.pylva_ensure_audit_log_partition(date)'
          )
          AND procedure.prosecdef
          AND procedure.provolatile = 'v'
          AND pg_catalog.cardinality(procedure.proconfig) = 2
          AND procedure.proconfig @> ARRAY[
            'search_path=pg_catalog'
          ]::pg_catalog.text[]
          AND (
            SELECT pg_catalog.count(*) = 1
            FROM pg_catalog.unnest(procedure.proconfig) AS setting(value)
            WHERE setting.value LIKE 'TimeZone=%'
              AND pg_catalog.length(setting.value) > pg_catalog.length('TimeZone=')
          )
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
      )
    FROM runtime_role AS runtime
  ), FALSE) AS runtime_ownership_safe,
  COALESCE((
    SELECT
      (
        SELECT pg_catalog.count(*) = 3
        FROM pg_catalog.pg_auth_members AS edge
        WHERE edge.roleid = runtime.oid
      )
      AND (
        SELECT pg_catalog.count(*) = 1
        FROM runtime_migrator
      )
      AND (
        SELECT pg_catalog.count(*) = 1
        FROM pg_catalog.pg_auth_members AS edge
        WHERE edge.roleid = runtime.oid
          AND edge.member = login.oid
          AND NOT edge.admin_option
          AND edge.inherit_option
          AND NOT edge.set_option
      )
      AND
      (
        SELECT pg_catalog.count(*) = 1
        FROM pg_catalog.pg_auth_members AS edge
        WHERE edge.member = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        CROSS JOIN runtime_migrator AS migrator
        WHERE edge.roleid = login.oid
          AND NOT (
            edge.member = migrator.oid
            AND edge.admin_option
            AND NOT edge.inherit_option
            AND NOT edge.set_option
          )
      )
      AND (
        SELECT pg_catalog.count(*) <= 1
        FROM pg_catalog.pg_auth_members AS edge
        WHERE edge.roleid = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members AS edge
        WHERE edge.member = runtime.oid
      )
    FROM login_role AS login
    CROSS JOIN runtime_role AS runtime
  ), FALSE) AS membership_graph_safe,
  COALESCE((
    SELECT
      NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_database AS database
        WHERE database.datdba = login.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace AS namespace
        WHERE namespace.nspowner = login.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class AS relation
        WHERE relation.relowner = login.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc AS procedure
        WHERE procedure.proowner = login.oid
      )
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_default_acl AS default_acl
        WHERE default_acl.defaclrole = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_default_acl AS default_acl
        CROSS JOIN LATERAL
          pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
    FROM login_role AS login
  ), FALSE) AS login_ownership_safe,
  COALESCE((
    SELECT
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_database AS database
        CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
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
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS procedure
        CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
        WHERE privilege.grantee = login.oid
      )
    FROM login_role AS login
  ), FALSE) AS login_direct_acl_safe,
  COALESCE((
    SELECT
      (SELECT pg_catalog.count(*) = 9 FROM authority_relations)
      AND (SELECT pg_catalog.count(*) = 1 FROM excluded_backup)
      AND (SELECT pg_catalog.count(*) = 1 FROM authority_sequence)
      AND discovery.projection_oid IS NOT NULL
      AND discovery.expiry_oid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM authority_relations AS relation
        CROSS JOIN LATERAL (VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
          ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
        ) AS candidate(privilege_type)
        WHERE pg_catalog.has_table_privilege(
          SESSION_USER,
          relation.oid,
          candidate.privilege_type
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM excluded_backup AS relation
        CROSS JOIN LATERAL (VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
          ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
        ) AS candidate(privilege_type)
        WHERE pg_catalog.has_table_privilege(
          SESSION_USER,
          relation.oid,
          candidate.privilege_type
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM (
          SELECT relation.oid FROM authority_relations AS relation
          UNION ALL
          SELECT relation.oid FROM excluded_backup AS relation
        ) AS relation
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
        CROSS JOIN LATERAL (VALUES
          ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
        ) AS candidate(privilege_type)
        WHERE attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(
            SESSION_USER,
            relation.oid,
            attribute.attnum,
            candidate.privilege_type
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM authority_sequence AS sequence
        CROSS JOIN LATERAL (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
          AS candidate(privilege_type)
        WHERE pg_catalog.has_sequence_privilege(
          SESSION_USER,
          sequence.oid,
          candidate.privilege_type
        )
      )
      AND NOT pg_catalog.has_function_privilege(
        SESSION_USER,
        discovery.projection_oid,
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        SESSION_USER,
        discovery.expiry_oid,
        'EXECUTE'
      )
    FROM discovery_functions AS discovery
  ), FALSE) AS authority_access_denied,
  COALESCE((
    SELECT
      (SELECT pg_catalog.count(*) = 1 FROM schema_migrations_relation)
      AND pg_catalog.has_table_privilege(
        SESSION_USER,
        relation.oid,
        'SELECT'
      )
      AND NOT pg_catalog.has_table_privilege(
        SESSION_USER,
        relation.oid,
        'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES'))
          AS candidate(privilege_type)
        WHERE attribute.attrelid = relation.oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND pg_catalog.has_column_privilege(
            SESSION_USER,
            relation.oid,
            attribute.attnum,
            candidate.privilege_type
          )
      )
    FROM schema_migrations_relation AS relation
  ), FALSE) AS schema_migrations_select_only,
  (SELECT pg_catalog.count(*) = 2 FROM legacy_crud_relations)
  AND NOT EXISTS (
    SELECT 1
    FROM legacy_crud_relations AS relation
    CROSS JOIN LATERAL (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
    ) AS candidate(privilege_type)
    WHERE NOT pg_catalog.has_table_privilege(
      SESSION_USER,
      relation.oid,
      candidate.privilege_type
    )
  ) AS legacy_crud_available,
  pg_catalog.has_schema_privilege(SESSION_USER, 'public', 'USAGE')
  AND pg_catalog.has_schema_privilege(SESSION_USER, 'public', 'CREATE')
  AND pg_catalog.has_database_privilege(
    SESSION_USER,
    pg_catalog.current_database(),
    'CONNECT'
  ) AS ambient_access_ready
`;

function strictBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Convert one catalog row into a stable reason that never includes credentials. */
export function evaluateGeneralAppRuntimeAttestation(
  rows: readonly GeneralAppRuntimeAttestationRow[],
): GeneralAppRuntimePostureReason | null {
  if (rows.length !== 1) return 'invalid_attestation';
  const row = rows[0]!;
  const values = {
    ambientAccessReady: strictBoolean(row.ambient_access_ready),
    authorityAccessDenied: strictBoolean(row.authority_access_denied),
    currentUserMatchesLogin: strictBoolean(row.current_user_matches_login),
    legacyCrudAvailable: strictBoolean(row.legacy_crud_available),
    loginDirectAclSafe: strictBoolean(row.login_direct_acl_safe),
    loginOwnershipSafe: strictBoolean(row.login_ownership_safe),
    loginRoleSafe: strictBoolean(row.login_role_safe),
    membershipGraphSafe: strictBoolean(row.membership_graph_safe),
    runtimeOwnershipSafe: strictBoolean(row.runtime_ownership_safe),
    runtimeRoleSafe: strictBoolean(row.runtime_role_safe),
    schemaMigrationsSelectOnly: strictBoolean(row.schema_migrations_select_only),
  };

  if (Object.values(values).some((value) => value === null)) return 'invalid_attestation';
  if (!values.currentUserMatchesLogin) return 'identity_mismatch';
  if (!values.loginRoleSafe) return 'unsafe_login_role';
  if (!values.runtimeRoleSafe) return 'unsafe_runtime_role';
  if (!values.runtimeOwnershipSafe) return 'unsafe_runtime_ownership';
  if (!values.membershipGraphSafe) return 'unsafe_membership_graph';
  if (!values.loginOwnershipSafe) return 'unsafe_login_ownership';
  if (!values.loginDirectAclSafe) return 'unsafe_login_acl';
  if (!values.authorityAccessDenied) return 'authority_access_exposed';
  if (!values.schemaMigrationsSelectOnly) return 'migration_ledger_access_invalid';
  if (!values.legacyCrudAvailable) return 'legacy_access_missing';
  if (!values.ambientAccessReady) return 'ambient_access_missing';
  return null;
}

export async function attestGeneralAppRuntime(
  client: Sql,
): Promise<GeneralAppRuntimePostureReason | null> {
  const rows = await client.unsafe<GeneralAppRuntimeAttestationRow[]>(
    GENERAL_APP_RUNTIME_ATTESTATION_SQL,
  );
  return evaluateGeneralAppRuntimeAttestation(rows);
}

async function inspectProductionPosture(): Promise<GeneralAppProductionPosture> {
  if (env.NODE_ENV !== 'production') {
    return { ready: true, reason: null, attested: false };
  }

  try {
    const reason = await attestGeneralAppRuntime(sql);
    if (reason !== null) {
      return { ready: false, reason, attested: false };
    }
  } catch {
    return {
      ready: false,
      reason: 'attestation_query_failed',
      attested: false,
    };
  }

  return { ready: true, reason: null, attested: true };
}

let posturePromise: Promise<GeneralAppProductionPosture> | undefined;

export function getGeneralAppProductionPosture(): Promise<GeneralAppProductionPosture> {
  if (!posturePromise) {
    posturePromise = inspectProductionPosture().then((posture) => {
      if (!posture.ready && posture.reason === 'attestation_query_failed') {
        posturePromise = undefined;
      }
      return posture;
    });
  }
  return posturePromise;
}

export class GeneralAppRuntimeNotReadyError extends Error {
  readonly reason: GeneralAppRuntimePostureReason;
  readonly status = 503 as const;
  readonly code = 'INTERNAL_ERROR' as const;

  constructor(reason: GeneralAppRuntimePostureReason) {
    super(`general application runtime posture is not ready (${reason})`);
    this.name = 'GeneralAppRuntimeNotReadyError';
    this.reason = reason;
  }
}

export async function assertGeneralAppRuntimeReadyForProduction(): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  const posture = await getGeneralAppProductionPosture();
  if (!posture.ready) throw new GeneralAppRuntimeNotReadyError(posture.reason);
}

export function _resetGeneralAppRuntimePostureForTests(): void {
  posturePromise = undefined;
}
