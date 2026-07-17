import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import {
  listMigrationFiles,
  type MigrationFile,
  type MigrateSqlClient,
} from './db-migrate-core.js';
import { readDbMigrateEnv } from './db-migrate-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '..', 'db/migrations');

export const API_KEY_SCOPE_CONTRACT = 'api_keys_scope' as const;
export const API_KEY_SCOPE_VALUES = ['agent_sdk', 'admin_api', 'data_import', 'universal'] as const;
export const API_KEY_SCOPE_MIGRATIONS = [
  '041_rename_api_key_scopes.sql',
  '048_universal_api_key_scope.sql',
] as const;

export const AUTHORITATIVE_BUDGET_LEDGER_CONTRACT = 'authoritative_budget_ledger' as const;
export const AUTHORITATIVE_BUDGET_LEDGER_MIGRATION =
  '050_authoritative_budget_control_ledger.sql' as const;
export const AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION =
  '051_authoritative_budget_control_runtime.sql' as const;
export const AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION =
  '052_authoritative_budget_control_runtime_roles.sql' as const;
export const AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION =
  '053_legacy_catalog_owner_rls_compatibility.sql' as const;
export const GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION =
  '054_general_app_runtime_owner_boundary.sql' as const;
export const AUTHORITATIVE_BUDGET_SCHEMA_HEAD = GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION;
export const AUTHORITATIVE_BUDGET_MIGRATIONS = [
  AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
  AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
  AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
  AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
  GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
] as const;
export const AUTHORITATIVE_BUDGET_MIGRATION_SHA256: Readonly<
  Record<(typeof AUTHORITATIVE_BUDGET_MIGRATIONS)[number], string>
> = {
  [AUTHORITATIVE_BUDGET_LEDGER_MIGRATION]:
    '3bd8b69ef1b09814e6cc0645b2eb188504fc84b4e15abbe5e42ddf704619218e',
  [AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION]:
    '3fabbc1236e562eddd1b83e4c8826abfb61d0eca73b8e4773b10d94599055af8',
  [AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION]:
    '3cc7efe258ceb49e9fd56789c3fdb9a0f6cd76e990d5f5681ecc24cde4172be6',
  [AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION]:
    'ba598fab2d79316926ebce3e853c61a1408dae14cd4bb40a0a572f0a90bb431f',
  [GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION]:
    'f6e3be6b0a190f00a2f620fdacbacbb34cdbfcc522a9d138a59e1142b7cd8dbb',
};
export const AUTHORITATIVE_BUDGET_AUTHORITY_ORDER_SEQUENCE =
  'pylva_budget_authority_order_seq' as const;
export const AUTHORITATIVE_BUDGET_LEDGER_TABLES = [
  'budget_account_opening_evidence',
  'budget_accounts',
  'budget_control_cutovers',
  'budget_cost_event_outbox',
  'budget_reservation_allocations',
  'budget_reservation_transitions',
  'budget_reservations',
  'budget_rule_revisions',
  'budget_usage_ledger',
] as const;
export const AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES = [
  ...AUTHORITATIVE_BUDGET_LEDGER_TABLES,
] as const;
export const AUTHORITATIVE_BUDGET_OWNER_BYPASS_RLS_TABLES = [
  'builders',
  'cost_sources',
  'custom_pricing',
  'rules',
] as const;
export const AUTHORITATIVE_BUDGET_RLS_TABLES = [
  ...AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES,
  ...AUTHORITATIVE_BUDGET_OWNER_BYPASS_RLS_TABLES,
] as const;
const AUTHORITATIVE_BUDGET_FORCED_RLS_TABLE_SET = new Set<string>(
  AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES,
);

interface ExpectedTenantPolicy {
  command: string;
  permissive: boolean;
  policy_name: string;
  roles: readonly string[];
  table_name: string;
  using_expression: string;
  with_check_expression: string | null;
}

const TENANT_BUILDER_EXPRESSION = "builder_id = current_setting('app.builder_id', true)::uuid";
const TENANT_ROOT_BUILDER_EXPRESSION = "id = current_setting('app.builder_id', true)::uuid";
const SAFE_TENANT_BUILDER_EXPRESSION = `builder_id = CASE
  WHEN pg_input_is_valid(current_setting('app.builder_id', TRUE), 'uuid')
  THEN current_setting('app.builder_id', TRUE)::uuid
  ELSE NULL::uuid
END`;
const PROJECTION_DISCOVERY_EXPRESSION = `(
  status = 'pending'
  AND available_at <= statement_timestamp()
  AND attempts < 2147483646
) OR (
  status = 'processing'
  AND lock_expires_at <= statement_timestamp()
) OR (
  status = 'projected'
  AND projection_verified_at IS NULL
)`;
const EXPIRY_DISCOVERY_EXPRESSION = `decision = 'reserved'
  AND state = 'reserved'
  AND expires_at <= statement_timestamp()`;

const ledgerIsolationPolicies: ExpectedTenantPolicy[] = AUTHORITATIVE_BUDGET_LEDGER_TABLES.map(
  (tableName) => {
    const expression =
      tableName === 'budget_cost_event_outbox' || tableName === 'budget_reservations'
        ? SAFE_TENANT_BUILDER_EXPRESSION
        : TENANT_BUILDER_EXPRESSION;
    return {
      command: 'ALL',
      permissive: true,
      policy_name: `${tableName}_isolation`,
      roles: ['public'],
      table_name: tableName,
      using_expression: expression,
      with_check_expression: expression,
    };
  },
);

export const AUTHORITATIVE_BUDGET_TENANT_POLICIES: readonly ExpectedTenantPolicy[] = [
  ...ledgerIsolationPolicies,
  {
    command: 'ALL',
    permissive: true,
    policy_name: 'builders_isolation',
    roles: ['public'],
    table_name: 'builders',
    using_expression: TENANT_ROOT_BUILDER_EXPRESSION,
    with_check_expression: TENANT_ROOT_BUILDER_EXPRESSION,
  },
  ...(['cost_sources', 'custom_pricing', 'rules'] as const).map((tableName) => ({
    command: 'ALL',
    permissive: true,
    policy_name: `${tableName}_isolation`,
    roles: ['public'] as const,
    table_name: tableName,
    using_expression: TENANT_BUILDER_EXPRESSION,
    with_check_expression: TENANT_BUILDER_EXPRESSION,
  })),
  {
    command: 'SELECT',
    permissive: true,
    policy_name: 'budget_cost_event_outbox_projection_discovery_allow',
    roles: ['pylva_budget_projection_discovery_owner'],
    table_name: 'budget_cost_event_outbox',
    using_expression: PROJECTION_DISCOVERY_EXPRESSION,
    with_check_expression: null,
  },
  {
    command: 'SELECT',
    permissive: false,
    policy_name: 'budget_cost_event_outbox_projection_discovery_limit',
    roles: ['pylva_budget_projection_discovery_owner'],
    table_name: 'budget_cost_event_outbox',
    using_expression: PROJECTION_DISCOVERY_EXPRESSION,
    with_check_expression: null,
  },
  {
    command: 'SELECT',
    permissive: true,
    policy_name: 'budget_reservations_expiry_discovery_allow',
    roles: ['pylva_budget_expiry_discovery_owner'],
    table_name: 'budget_reservations',
    using_expression: EXPIRY_DISCOVERY_EXPRESSION,
    with_check_expression: null,
  },
  {
    command: 'SELECT',
    permissive: false,
    policy_name: 'budget_reservations_expiry_discovery_limit',
    roles: ['pylva_budget_expiry_discovery_owner'],
    table_name: 'budget_reservations',
    using_expression: EXPIRY_DISCOVERY_EXPRESSION,
    with_check_expression: null,
  },
];
export const PHYSICAL_SCHEMA_CONTRACTS = [
  API_KEY_SCOPE_CONTRACT,
  AUTHORITATIVE_BUDGET_LEDGER_CONTRACT,
] as const;

interface ExpectedTenantForeignKey {
  child_columns: readonly string[];
  child_table: string;
  constraint_name: string;
  deferrable: boolean;
  delete_action: string;
  initially_deferred: boolean;
  match_type?: string;
  parent_columns: readonly string[];
  parent_table: string;
  update_action?: string;
}

interface ExpectedLedgerIndex {
  descending_columns?: readonly string[];
  included_columns?: readonly string[];
  index_name: string;
  key_columns: readonly string[];
  nulls_not_distinct: boolean;
  predicate: string | null;
  table_name: string;
  unique: boolean;
}

interface ExpectedLedgerTrigger {
  before: boolean;
  constraint_trigger: boolean;
  deferrable: boolean;
  delete_event: boolean;
  function_name: string;
  initially_deferred: boolean;
  insert_event: boolean;
  row_level: boolean;
  table_name: string;
  trigger_name: string;
  truncate_event: boolean;
  update_event: boolean;
}

interface ExpectedLedgerSequence {
  cache_size: string;
  cycle: boolean;
  data_type: string;
  increment_by: string;
  max_value: string;
  min_value: string;
  owned_by_column: boolean;
  public_has_no_privileges: boolean;
  sequence_name: string;
  start_value: string;
}

export const AUTHORITATIVE_BUDGET_REQUIRED_SEQUENCES: readonly ExpectedLedgerSequence[] = [
  {
    cache_size: '1',
    cycle: false,
    data_type: 'bigint',
    increment_by: '1',
    max_value: '9223372036854775806',
    min_value: '1',
    owned_by_column: false,
    public_has_no_privileges: true,
    sequence_name: AUTHORITATIVE_BUDGET_AUTHORITY_ORDER_SEQUENCE,
    start_value: '1',
  },
];

type LedgerColumnDefault =
  | 'empty_object'
  | 'empty_uuid_array'
  | 'false'
  | 'none'
  | 'now'
  | 'statement_timestamp'
  | 'text:none'
  | 'text:pending'
  | 'text:unknown'
  | 'uuid'
  | 'zero'
  | 'zero_hash';

interface ExpectedLedgerColumn {
  column_name: string;
  data_type: string;
  default_kind: LedgerColumnDefault;
  nullable: boolean;
  table_name: string;
}

type LedgerColumnSpec = readonly [
  column_name: string,
  data_type: string,
  nullable: boolean,
  default_kind?: LedgerColumnDefault,
];

function ledgerColumns(
  table_name: string,
  specs: readonly LedgerColumnSpec[],
): ExpectedLedgerColumn[] {
  return specs.map(([column_name, data_type, nullable, default_kind = 'none']) => ({
    column_name,
    data_type,
    default_kind,
    nullable,
    table_name,
  }));
}

export const AUTHORITATIVE_BUDGET_COLUMNS: readonly ExpectedLedgerColumn[] = [
  ...ledgerColumns('budget_accounts', [
    ['builder_id', 'uuid', false],
    ['id', 'uuid', false, 'uuid'],
    ['rule_key', 'uuid', false],
    ['enforcement', 'character varying(20)', false],
    ['limit_usd', 'numeric(38,18)', false],
    ['scope', 'character varying(20)', false],
    ['subject_customer_id', 'character varying(255)', true],
    ['period', 'character varying(20)', false],
    ['period_start', 'timestamp with time zone', false],
    ['period_end', 'timestamp with time zone', false],
    ['initial_rule_revision_id', 'uuid', false],
    ['initial_rule_snapshot', 'jsonb', false],
    ['initial_rule_snapshot_hash', 'character(64)', false],
    ['opening_committed_usd', 'numeric(38,18)', false],
    ['committed_usd', 'numeric', false, 'zero'],
    ['reserved_usd', 'numeric(38,18)', false, 'zero'],
    ['unresolved_usd', 'numeric(38,18)', false, 'zero'],
    ['version', 'bigint', false, 'zero'],
    ['created_at', 'timestamp with time zone', false, 'now'],
    ['updated_at', 'timestamp with time zone', false, 'now'],
  ]),
  ...ledgerColumns('budget_rule_revisions', [
    ['builder_id', 'uuid', false],
    ['id', 'uuid', false, 'uuid'],
    ['rule_key', 'uuid', false],
    ['revision', 'bigint', false],
    ['scope', 'character varying(20)', false],
    ['target_customer_id', 'character varying(255)', true],
    ['period', 'character varying(20)', false],
    ['enforcement', 'character varying(20)', false],
    ['limit_usd', 'numeric(38,18)', false],
    ['config_snapshot', 'jsonb', false],
    ['config_snapshot_hash', 'character(64)', false],
    ['authority_order', 'bigint', false],
    ['active_from', 'timestamp with time zone', false, 'now'],
    ['retired_at', 'timestamp with time zone', true],
    ['retirement_reason', 'character varying(20)', true],
    ['created_at', 'timestamp with time zone', false, 'now'],
  ]),
  ...ledgerColumns('budget_reservations', [
    ['builder_id', 'uuid', false],
    ['decision_id', 'uuid', false, 'uuid'],
    ['reservation_id', 'uuid', true],
    ['operation_id', 'uuid', false],
    ['schema_version', 'character varying(10)', false],
    ['request_hash', 'character(64)', false],
    ['request_snapshot', 'jsonb', false],
    ['mode', 'character varying(10)', false],
    ['kind', 'character varying(10)', false],
    ['customer_id', 'character varying(255)', false],
    ['trace_id', 'uuid', false],
    ['span_id', 'uuid', false],
    ['parent_span_id', 'uuid', true],
    ['step_name', 'character varying(200)', true],
    ['framework', 'character varying(40)', false, 'text:none'],
    ['reservation_ttl_seconds', 'integer', false],
    ['provider', 'character varying(255)', true],
    ['model', 'character varying(255)', true],
    ['estimated_input_tokens', 'bigint', true],
    ['max_output_tokens', 'bigint', true],
    ['cost_source_slug', 'character varying(100)', true],
    ['tool_name', 'character varying(200)', true],
    ['metric', 'character varying(100)', true],
    ['maximum_value', 'numeric(38,18)', true],
    ['decision', 'character varying(20)', false],
    ['decision_reason', 'character varying(80)', true],
    ['would_have_denied', 'boolean', true],
    ['state', 'character varying(20)', true],
    ['pricing_snapshot', 'jsonb', true],
    ['pricing_snapshot_hash', 'character(64)', true],
    ['requested_usd', 'numeric(38,18)', true],
    ['reserved_usd', 'numeric(38,18)', false, 'zero'],
    ['actual_usd', 'numeric(44,18)', false, 'zero'],
    ['released_usd', 'numeric(38,18)', false, 'zero'],
    ['overage_usd', 'numeric(44,18)', false, 'zero'],
    ['remaining_usd', 'numeric(38,18)', true],
    ['deciding_account_id', 'uuid', true],
    ['reserve_response_snapshot', 'jsonb', false],
    ['rule_revision_ids', 'uuid[]', false, 'empty_uuid_array'],
    ['rule_set_hash', 'character(64)', false, 'zero_hash'],
    ['authorization_transaction_id', 'bigint', false, 'zero'],
    ['expires_at', 'timestamp with time zone', true],
    ['reserved_at', 'timestamp with time zone', true],
    ['refused_at', 'timestamp with time zone', true],
    ['committed_at', 'timestamp with time zone', true],
    ['released_at', 'timestamp with time zone', true],
    ['unresolved_at', 'timestamp with time zone', true],
    ['unresolved_reason', 'character varying(80)', true],
    ['state_version', 'bigint', false, 'zero'],
    ['created_at', 'timestamp with time zone', false, 'now'],
    ['updated_at', 'timestamp with time zone', false, 'now'],
  ]),
  ...ledgerColumns('budget_reservation_allocations', [
    ['builder_id', 'uuid', false],
    ['id', 'uuid', false, 'uuid'],
    ['reservation_decision_id', 'uuid', false],
    ['account_id', 'uuid', false],
    ['rule_key', 'uuid', false],
    ['rule_revision_id', 'uuid', false],
    ['rule_snapshot', 'jsonb', false],
    ['rule_snapshot_hash', 'character(64)', false],
    ['enforcement', 'character varying(20)', false],
    ['evaluation_order', 'integer', false],
    ['is_deciding', 'boolean', false, 'false'],
    ['account_version_before', 'bigint', false],
    ['held_at_reserve', 'boolean', false],
    ['status', 'character varying(30)', false],
    ['committed_before_usd', 'numeric(38,18)', false],
    ['reserved_before_usd', 'numeric(38,18)', false],
    ['unresolved_before_usd', 'numeric(38,18)', false],
    ['requested_usd', 'numeric(38,18)', false],
    ['projected_usd', 'numeric(38,18)', false],
    ['limit_usd', 'numeric(38,18)', false],
    ['remaining_usd', 'numeric(38,18)', false],
    ['authorized_usd', 'numeric(38,18)', false, 'zero'],
    ['actual_usd', 'numeric(44,18)', false, 'zero'],
    ['released_usd', 'numeric(38,18)', false, 'zero'],
    ['unresolved_usd', 'numeric(38,18)', false, 'zero'],
    ['overage_usd', 'numeric(44,18)', false, 'zero'],
    ['created_at', 'timestamp with time zone', false, 'now'],
    ['updated_at', 'timestamp with time zone', false, 'now'],
  ]),
  ...ledgerColumns('budget_reservation_transitions', [
    ['builder_id', 'uuid', false],
    ['id', 'uuid', false, 'uuid'],
    ['reservation_decision_id', 'uuid', false],
    ['type', 'character varying(30)', false],
    ['extension_id', 'uuid', true],
    ['release_reason', 'character varying(50)', true],
    ['request_hash', 'character(64)', false],
    ['request_snapshot', 'jsonb', false],
    ['response_snapshot', 'jsonb', false],
    ['from_state', 'character varying(20)', false],
    ['to_state', 'character varying(20)', false],
    ['from_state_version', 'bigint', false],
    ['to_state_version', 'bigint', false],
    ['from_expires_at', 'timestamp with time zone', false],
    ['to_expires_at', 'timestamp with time zone', false],
    ['extend_by_seconds', 'integer', true],
    ['occurred_at', 'timestamp with time zone', false, 'statement_timestamp'],
  ]),
  ...ledgerColumns('budget_usage_ledger', [
    ['builder_id', 'uuid', false],
    ['id', 'uuid', false, 'uuid'],
    ['reservation_decision_id', 'uuid', false],
    ['operation_id', 'uuid', false],
    ['cost_event_id', 'uuid', false],
    ['customer_id', 'character varying(255)', false],
    ['trace_id', 'uuid', false],
    ['span_id', 'uuid', false],
    ['parent_span_id', 'uuid', true],
    ['step_name', 'character varying(200)', true],
    ['framework', 'character varying(40)', false, 'text:none'],
    ['sdk_version', 'character varying(50)', false, 'text:unknown'],
    ['sdk_language', 'character varying(20)', false, 'text:unknown'],
    ['kind', 'character varying(10)', false],
    ['provider', 'character varying(255)', true],
    ['model', 'character varying(255)', true],
    ['actual_input_tokens', 'bigint', true],
    ['actual_output_tokens', 'bigint', true],
    ['cost_source_slug', 'character varying(100)', true],
    ['tool_name', 'character varying(200)', true],
    ['metric', 'character varying(100)', true],
    ['actual_value', 'numeric(38,18)', true],
    ['status', 'character varying(20)', false],
    ['latency_ms', 'bigint', false],
    ['stream_aborted', 'boolean', false],
    ['actual_cost_usd', 'numeric(44,18)', false],
    ['pricing_snapshot', 'jsonb', true],
    ['pricing_snapshot_hash', 'character(64)', false],
    ['usage_snapshot', 'jsonb', true],
    ['usage_snapshot_hash', 'character(64)', false],
    ['cost_source', 'character varying(20)', false],
    ['instrumentation_tier', 'character varying(20)', false],
    ['is_demo', 'boolean', false, 'false'],
    ['retention_days', 'integer', false],
    ['billing_retention_days', 'integer', false],
    ['metadata', 'jsonb', true, 'empty_object'],
    ['committed_at', 'timestamp with time zone', false],
    ['retain_until', 'timestamp with time zone', false],
    ['details_purged_at', 'timestamp with time zone', true],
    ['created_at', 'timestamp with time zone', false, 'statement_timestamp'],
  ]),
  ...ledgerColumns('budget_cost_event_outbox', [
    ['builder_id', 'uuid', false],
    ['id', 'uuid', false, 'uuid'],
    ['usage_ledger_id', 'uuid', false],
    ['cost_event_id', 'uuid', false],
    ['payload_schema_version', 'character varying(10)', false],
    ['payload', 'jsonb', true],
    ['payload_hash', 'character(64)', false],
    ['status', 'character varying(20)', false, 'text:pending'],
    ['attempts', 'integer', false, 'zero'],
    ['available_at', 'timestamp with time zone', false, 'now'],
    ['locked_at', 'timestamp with time zone', true],
    ['lock_expires_at', 'timestamp with time zone', true],
    ['lock_owner', 'character varying(100)', true],
    ['last_attempt_at', 'timestamp with time zone', true],
    ['projected_at', 'timestamp with time zone', true],
    ['projection_verified_at', 'timestamp with time zone', true],
    ['payload_purged_at', 'timestamp with time zone', true],
    ['last_error_code', 'character varying(80)', true],
    ['last_error_message', 'character varying(1000)', true],
    ['created_at', 'timestamp with time zone', false, 'now'],
    ['updated_at', 'timestamp with time zone', false, 'now'],
  ]),
  ...ledgerColumns('budget_control_cutovers', [
    ['builder_id', 'uuid', false],
    ['status', 'character varying(20)', false, 'text:pending'],
    ['mode', 'character varying(20)', false],
    ['cutover_at', 'timestamp with time zone', false, 'now'],
    ['reconciled_through', 'timestamp with time zone', true],
    ['reconciliation_snapshot', 'jsonb', true],
    ['reconciliation_snapshot_hash', 'character(64)', true],
    ['ready_at', 'timestamp with time zone', true],
    ['ready_order', 'bigint', true],
    ['created_at', 'timestamp with time zone', false, 'now'],
    ['updated_at', 'timestamp with time zone', false, 'now'],
  ]),
  ...ledgerColumns('budget_account_opening_evidence', [
    ['builder_id', 'uuid', false],
    ['account_id', 'uuid', false],
    ['source', 'character varying(30)', false],
    ['opening_committed_usd', 'numeric(38,18)', false],
    ['measured_through', 'timestamp with time zone', false],
    ['evidence_snapshot', 'jsonb', false],
    ['evidence_snapshot_hash', 'character(64)', false],
    ['created_at', 'timestamp with time zone', false, 'now'],
  ]),
];

// These lists intentionally describe the exact security- and correctness-
// relevant objects after migrations 050 and 051. Keep them explicit: inferring the
// contract from whatever happens to be installed would make drift invisible.
export const AUTHORITATIVE_BUDGET_NUMERIC_COLUMNS: readonly string[] = [
  'budget_accounts.limit_usd',
  'budget_accounts.opening_committed_usd',
  'budget_accounts.reserved_usd',
  'budget_accounts.unresolved_usd',
  'budget_reservation_allocations.authorized_usd',
  'budget_reservation_allocations.committed_before_usd',
  'budget_reservation_allocations.limit_usd',
  'budget_reservation_allocations.projected_usd',
  'budget_reservation_allocations.released_usd',
  'budget_reservation_allocations.remaining_usd',
  'budget_reservation_allocations.requested_usd',
  'budget_reservation_allocations.reserved_before_usd',
  'budget_reservation_allocations.unresolved_before_usd',
  'budget_reservation_allocations.unresolved_usd',
  'budget_reservations.maximum_value',
  'budget_reservations.released_usd',
  'budget_reservations.remaining_usd',
  'budget_reservations.requested_usd',
  'budget_reservations.reserved_usd',
  'budget_rule_revisions.limit_usd',
  'budget_usage_ledger.actual_value',
  'budget_account_opening_evidence.opening_committed_usd',
];
export const AUTHORITATIVE_BUDGET_WIDE_NUMERIC_COLUMNS: readonly string[] = [
  'budget_reservation_allocations.actual_usd',
  'budget_reservation_allocations.overage_usd',
  'budget_reservations.actual_usd',
  'budget_reservations.overage_usd',
  'budget_usage_ledger.actual_cost_usd',
];
export const AUTHORITATIVE_BUDGET_UNBOUNDED_NUMERIC_COLUMNS: readonly string[] = [
  'budget_accounts.committed_usd',
];
export const AUTHORITATIVE_BUDGET_TENANT_FOREIGN_KEYS: readonly ExpectedTenantForeignKey[] = [
  {
    child_columns: ['builder_id'],
    child_table: 'budget_account_opening_evidence',
    constraint_name: 'budget_account_opening_evidence_cutover_fk',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['builder_id'],
    parent_table: 'budget_control_cutovers',
  },
  {
    child_columns: ['builder_id', 'account_id'],
    child_table: 'budget_account_opening_evidence',
    constraint_name: 'budget_account_opening_evidence_account_fk',
    deferrable: true,
    delete_action: 'RESTRICT',
    initially_deferred: true,
    parent_columns: ['builder_id', 'id'],
    parent_table: 'budget_accounts',
  },
  {
    child_columns: ['builder_id'],
    child_table: 'budget_accounts',
    constraint_name: 'budget_accounts_builder_id_fkey',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['id'],
    parent_table: 'builders',
  },
  {
    child_columns: ['builder_id', 'initial_rule_revision_id', 'rule_key'],
    child_table: 'budget_accounts',
    constraint_name: 'budget_accounts_initial_rule_revision_fk',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['builder_id', 'id', 'rule_key'],
    parent_table: 'budget_rule_revisions',
  },
  {
    child_columns: ['builder_id', 'usage_ledger_id', 'cost_event_id'],
    child_table: 'budget_cost_event_outbox',
    constraint_name: 'budget_cost_event_outbox_usage_fk',
    deferrable: true,
    delete_action: 'RESTRICT',
    initially_deferred: true,
    parent_columns: ['builder_id', 'id', 'cost_event_id'],
    parent_table: 'budget_usage_ledger',
  },
  {
    child_columns: ['builder_id'],
    child_table: 'budget_control_cutovers',
    constraint_name: 'budget_control_cutovers_builder_id_fkey',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['id'],
    parent_table: 'builders',
  },
  {
    child_columns: ['builder_id', 'account_id', 'rule_key'],
    child_table: 'budget_reservation_allocations',
    constraint_name: 'budget_reservation_allocations_account_fk',
    deferrable: true,
    delete_action: 'RESTRICT',
    initially_deferred: true,
    parent_columns: ['builder_id', 'id', 'rule_key'],
    parent_table: 'budget_accounts',
  },
  {
    child_columns: ['builder_id', 'reservation_decision_id'],
    child_table: 'budget_reservation_allocations',
    constraint_name: 'budget_reservation_allocations_reservation_fk',
    deferrable: true,
    delete_action: 'CASCADE',
    initially_deferred: true,
    parent_columns: ['builder_id', 'decision_id'],
    parent_table: 'budget_reservations',
  },
  {
    child_columns: ['builder_id', 'rule_revision_id', 'rule_key'],
    child_table: 'budget_reservation_allocations',
    constraint_name: 'budget_reservation_allocations_rule_revision_fk',
    deferrable: true,
    delete_action: 'RESTRICT',
    initially_deferred: true,
    parent_columns: ['builder_id', 'id', 'rule_key'],
    parent_table: 'budget_rule_revisions',
  },
  {
    child_columns: ['builder_id', 'reservation_decision_id'],
    child_table: 'budget_reservation_transitions',
    constraint_name: 'budget_reservation_transitions_reservation_fk',
    deferrable: true,
    delete_action: 'CASCADE',
    initially_deferred: true,
    parent_columns: ['builder_id', 'decision_id'],
    parent_table: 'budget_reservations',
  },
  {
    child_columns: ['builder_id', 'deciding_account_id'],
    child_table: 'budget_reservations',
    constraint_name: 'budget_reservations_deciding_account_fk',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['builder_id', 'id'],
    parent_table: 'budget_accounts',
  },
  {
    child_columns: ['builder_id'],
    child_table: 'budget_reservations',
    constraint_name: 'budget_reservations_builder_id_fkey',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['id'],
    parent_table: 'builders',
  },
  {
    child_columns: ['builder_id', 'decision_id', 'deciding_account_id'],
    child_table: 'budget_reservations',
    constraint_name: 'budget_reservations_deciding_allocation_fk',
    deferrable: true,
    delete_action: 'NO ACTION',
    initially_deferred: true,
    parent_columns: ['builder_id', 'reservation_decision_id', 'account_id'],
    parent_table: 'budget_reservation_allocations',
  },
  {
    child_columns: ['builder_id'],
    child_table: 'budget_rule_revisions',
    constraint_name: 'budget_rule_revisions_builder_id_fkey',
    deferrable: false,
    delete_action: 'RESTRICT',
    initially_deferred: false,
    parent_columns: ['id'],
    parent_table: 'builders',
  },
  {
    child_columns: ['builder_id', 'reservation_decision_id', 'operation_id'],
    child_table: 'budget_usage_ledger',
    constraint_name: 'budget_usage_ledger_reservation_fk',
    deferrable: true,
    delete_action: 'RESTRICT',
    initially_deferred: true,
    parent_columns: ['builder_id', 'decision_id', 'operation_id'],
    parent_table: 'budget_reservations',
  },
];
export const AUTHORITATIVE_BUDGET_REQUIRED_INDEXES: readonly ExpectedLedgerIndex[] = [
  {
    index_name: 'idx_budget_accounts_builder_period',
    key_columns: [
      'builder_id',
      'period_start',
      'period_end',
      'rule_key',
      'scope',
      'subject_customer_id',
      'id',
    ],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_accounts',
    unique: false,
  },
  {
    index_name: 'idx_budget_accounts_builder_rule',
    key_columns: ['builder_id', 'rule_key'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_accounts',
    unique: false,
  },
  {
    index_name: 'budget_rule_revisions_one_active_uk',
    key_columns: ['builder_id', 'rule_key'],
    nulls_not_distinct: false,
    predicate: 'retired_at IS NULL',
    table_name: 'budget_rule_revisions',
    unique: true,
  },
  {
    descending_columns: ['revision'],
    index_name: 'idx_budget_rule_revisions_builder_rule',
    key_columns: ['builder_id', 'rule_key', 'revision'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_rule_revisions',
    unique: false,
  },
  {
    index_name: 'idx_budget_rule_revisions_active_scope',
    key_columns: ['builder_id', 'scope', 'target_customer_id', 'period', 'rule_key', 'id'],
    nulls_not_distinct: false,
    predicate: 'retired_at IS NULL',
    table_name: 'budget_rule_revisions',
    unique: false,
  },
  {
    index_name: 'idx_budget_cost_event_outbox_builder_status',
    descending_columns: ['updated_at'],
    key_columns: ['builder_id', 'status', 'updated_at'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_cost_event_outbox',
    unique: false,
  },
  {
    index_name: 'idx_budget_cost_event_outbox_expired_lease',
    key_columns: ['lock_expires_at', 'builder_id', 'id'],
    nulls_not_distinct: false,
    predicate: "status = 'processing'",
    table_name: 'budget_cost_event_outbox',
    unique: false,
  },
  {
    index_name: 'idx_budget_cost_event_outbox_pending',
    key_columns: ['available_at', 'created_at', 'builder_id', 'id'],
    nulls_not_distinct: false,
    predicate: "status = 'pending'",
    table_name: 'budget_cost_event_outbox',
    unique: false,
  },
  {
    index_name: 'idx_budget_cost_event_outbox_projected_unverified',
    key_columns: ['builder_id'],
    nulls_not_distinct: false,
    predicate: "status = 'projected' AND projection_verified_at IS NULL",
    table_name: 'budget_cost_event_outbox',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservation_allocations_account',
    included_columns: ['authorized_usd', 'actual_usd', 'unresolved_usd'],
    key_columns: ['builder_id', 'account_id', 'status'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservation_allocations',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservation_allocations_decision_status',
    included_columns: ['account_id', 'is_deciding', 'requested_usd', 'actual_usd'],
    key_columns: ['builder_id', 'reservation_decision_id', 'status'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservation_allocations',
    unique: false,
  },
  {
    index_name: 'budget_reservation_allocations_observed_version_uk',
    key_columns: ['builder_id', 'account_id', 'account_version_before'],
    nulls_not_distinct: false,
    predicate: 'held_at_reserve',
    table_name: 'budget_reservation_allocations',
    unique: true,
  },
  {
    index_name: 'budget_reservation_allocations_deciding_uk',
    key_columns: ['builder_id', 'reservation_decision_id'],
    nulls_not_distinct: false,
    predicate: 'is_deciding',
    table_name: 'budget_reservation_allocations',
    unique: true,
  },
  {
    index_name: 'budget_reservation_transitions_idempotency_uk',
    key_columns: ['builder_id', 'reservation_decision_id', 'type', 'extension_id'],
    nulls_not_distinct: true,
    predicate: null,
    table_name: 'budget_reservation_transitions',
    unique: true,
  },
  {
    index_name: 'budget_reservation_transitions_terminal_uk',
    key_columns: ['builder_id', 'reservation_decision_id'],
    nulls_not_distinct: false,
    predicate: "type IN ('commit', 'release')",
    table_name: 'budget_reservation_transitions',
    unique: true,
  },
  {
    index_name: 'budget_reservation_transitions_from_version_uk',
    key_columns: ['builder_id', 'reservation_decision_id', 'from_state_version'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservation_transitions',
    unique: true,
  },
  {
    index_name: 'budget_reservation_transitions_to_version_uk',
    key_columns: ['builder_id', 'reservation_decision_id', 'to_state_version'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservation_transitions',
    unique: true,
  },
  {
    index_name: 'idx_budget_reservation_transitions_decision_occurred',
    key_columns: ['builder_id', 'reservation_decision_id', 'occurred_at', 'id'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservation_transitions',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservations_builder_customer_created',
    descending_columns: ['created_at'],
    key_columns: ['builder_id', 'customer_id', 'created_at'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservations',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservations_builder_state_updated',
    descending_columns: ['updated_at'],
    key_columns: ['builder_id', 'state', 'updated_at'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservations',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservations_builder_authorization_tx',
    key_columns: ['builder_id', 'authorization_transaction_id'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_reservations',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservations_expiry',
    key_columns: ['expires_at', 'builder_id', 'decision_id'],
    nulls_not_distinct: false,
    predicate: "state = 'reserved'",
    table_name: 'budget_reservations',
    unique: false,
  },
  {
    index_name: 'idx_budget_reservations_expiry_discovery',
    key_columns: ['builder_id', 'expires_at', 'decision_id'],
    nulls_not_distinct: false,
    predicate: "state = 'reserved' AND decision = 'reserved'",
    table_name: 'budget_reservations',
    unique: false,
  },
  {
    index_name: 'budget_reservations_reservation_uk',
    key_columns: ['builder_id', 'reservation_id'],
    nulls_not_distinct: false,
    predicate: 'reservation_id IS NOT NULL',
    table_name: 'budget_reservations',
    unique: true,
  },
  {
    index_name: 'idx_budget_usage_ledger_builder_committed',
    descending_columns: ['committed_at'],
    key_columns: ['builder_id', 'committed_at', 'id'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_usage_ledger',
    unique: false,
  },
  {
    index_name: 'idx_budget_usage_ledger_retain_until',
    key_columns: ['retain_until', 'builder_id', 'id'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_usage_ledger',
    unique: false,
  },
  {
    index_name: 'idx_budget_usage_ledger_purge_ready',
    key_columns: ['builder_id', 'retain_until', 'id'],
    nulls_not_distinct: false,
    predicate: 'details_purged_at IS NULL',
    table_name: 'budget_usage_ledger',
    unique: false,
  },
  {
    index_name: 'idx_budget_usage_ledger_trace',
    descending_columns: ['committed_at'],
    key_columns: ['builder_id', 'trace_id', 'committed_at'],
    nulls_not_distinct: false,
    predicate: null,
    table_name: 'budget_usage_ledger',
    unique: false,
  },
];
export const AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS: ExpectedLedgerIndex = {
  index_name: 'budget_accounts_natural_identity_uk',
  key_columns: ['builder_id', 'rule_key', 'scope', 'subject_customer_id', 'period', 'period_start'],
  nulls_not_distinct: true,
  predicate: null,
  table_name: 'budget_accounts',
  unique: true,
};
type LedgerTriggerEvent = 'delete' | 'insert' | 'update';

function ledgerTrigger(
  table_name: string,
  trigger_name: string,
  function_name: string,
  before: boolean,
  events: readonly LedgerTriggerEvent[],
  constraint_trigger = false,
): ExpectedLedgerTrigger {
  return {
    before,
    constraint_trigger,
    deferrable: constraint_trigger,
    delete_event: events.includes('delete'),
    function_name,
    initially_deferred: constraint_trigger,
    insert_event: events.includes('insert'),
    row_level: true,
    table_name,
    trigger_name,
    truncate_event: false,
    update_event: events.includes('update'),
  };
}

export const AUTHORITATIVE_BUDGET_REQUIRED_TRIGGERS: readonly ExpectedLedgerTrigger[] = [
  ledgerTrigger(
    'budget_account_opening_evidence',
    'budget_account_opening_evidence_guard',
    'pylva_budget_opening_evidence_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_account_opening_evidence',
    'budget_account_opening_evidence_consistency_guard',
    'pylva_budget_opening_evidence_consistency_guard',
    false,
    ['insert'],
    true,
  ),
  ledgerTrigger(
    'budget_accounts',
    'budget_accounts_immutability_guard',
    'pylva_budget_accounts_immutability_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_accounts',
    'budget_accounts_opening_evidence_consistency_guard',
    'pylva_budget_account_opening_consistency_guard',
    false,
    ['insert'],
    true,
  ),
  ledgerTrigger(
    'budget_control_cutovers',
    'budget_control_cutovers_guard',
    'pylva_budget_cutovers_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_rule_revisions',
    'budget_rule_revisions_immutability_guard',
    'pylva_budget_rule_revisions_immutability_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_rule_revisions',
    'budget_rule_revisions_authority_order_guard',
    'pylva_budget_rule_revision_authority_order_guard',
    true,
    ['insert'],
  ),
  ledgerTrigger(
    'budget_cost_event_outbox',
    'budget_cost_event_outbox_immutability_guard',
    'pylva_budget_outbox_immutability_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_cost_event_outbox',
    'budget_cost_event_outbox_retention_pair_guard',
    'pylva_budget_outbox_retention_pair_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_reservation_allocations',
    'budget_reservation_allocations_immutability_guard',
    'pylva_budget_allocations_immutability_guard',
    true,
    ['update', 'delete'],
  ),
  ledgerTrigger(
    'budget_reservation_allocations',
    'budget_reservation_allocations_insert_guard',
    'pylva_budget_allocation_insert_guard',
    true,
    ['insert'],
  ),
  ledgerTrigger(
    'budget_reservation_allocations',
    'budget_reservation_allocations_parent_consistency_guard',
    'pylva_budget_allocation_reservation_consistency_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_reservation_allocations',
    'budget_reservation_allocations_posting_guard',
    'pylva_budget_apply_allocation_posting',
    false,
    ['insert', 'update'],
  ),
  ledgerTrigger(
    'budget_rule_revisions',
    'budget_rule_revisions_successor_consistency_guard',
    'pylva_budget_revision_successor_consistency_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_reservation_transitions',
    'budget_reservation_transitions_append_only_guard',
    'pylva_budget_append_only_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_reservation_transitions',
    'budget_reservation_transitions_parent_consistency_guard',
    'pylva_budget_transition_parent_consistency_guard',
    false,
    ['insert'],
    true,
  ),
  ledgerTrigger(
    'budget_reservations',
    'budget_reservations_allocations_consistency_guard',
    'pylva_budget_reservation_allocations_consistency_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_reservations',
    'budget_reservations_readiness_consistency_guard',
    'pylva_budget_reservation_readiness_consistency_guard',
    false,
    ['insert'],
    true,
  ),
  ledgerTrigger(
    'budget_reservations',
    'budget_reservations_immutability_guard',
    'pylva_budget_reservations_immutability_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_reservations',
    'budget_reservations_transition_consistency_guard',
    'pylva_budget_reservation_transition_consistency_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_reservations',
    'budget_reservations_usage_consistency_guard',
    'pylva_budget_reservation_usage_consistency_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_usage_ledger',
    'budget_usage_ledger_immutability_guard',
    'pylva_budget_usage_immutability_guard',
    true,
    ['insert', 'update', 'delete'],
  ),
  ledgerTrigger(
    'budget_usage_ledger',
    'budget_usage_ledger_parent_consistency_guard',
    'pylva_budget_usage_parent_consistency_guard',
    false,
    ['insert', 'update'],
    true,
  ),
  ledgerTrigger(
    'budget_usage_ledger',
    'budget_usage_ledger_retention_pair_guard',
    'pylva_budget_usage_retention_pair_guard',
    false,
    ['insert', 'update'],
    true,
  ),
];

// Backwards-compatible export name for callers that predate the broader
// trigger contract. It now intentionally contains every migration-050/051 trigger.
export const AUTHORITATIVE_BUDGET_IMMUTABILITY_TRIGGERS = AUTHORITATIVE_BUDGET_REQUIRED_TRIGGERS;

interface ExpectedLedgerCheck {
  constraint_name: string;
  definition_hash: string;
  table_name: string;
}

const AUTHORITATIVE_BUDGET_CHECK_DEFINITION_HASHES: Readonly<Record<string, string>> = {
  'budget_account_opening_evidence.budget_account_opening_evidence_amount_ck':
    '47e224865cc7bde1ae83904e88b5dc24a68510658b8ef903caf2159af58d8396',
  'budget_account_opening_evidence.budget_account_opening_evidence_snapshot_ck':
    '2d5ca987a2aa71a321140c09309b1ae2e7715d7a7c616960119c5dd942769ab8',
  'budget_account_opening_evidence.budget_account_opening_evidence_source_ck':
    'fac439d4464a16c3655fbd749540546b3cb03d2a57f4c814ded373005d40de68',
  'budget_account_opening_evidence.budget_account_opening_evidence_timestamps_ck':
    '20fed5e3e51ecbb2ad2118532715e6a33da16287b64552c16fdb62c7e2a9585d',
  'budget_accounts.budget_accounts_amounts_ck':
    '29d0f22b439c40aafd040f6268ddffd53ef6fd4fb5461ef37a9d13c622d937ff',
  'budget_accounts.budget_accounts_customer_scope_ck':
    '059889eaef82dcba0ef5789624e20c736be7d16475a1cd91ee41ecd6f546d6ec',
  'budget_accounts.budget_accounts_enforcement_ck':
    '241d17a3c1cb1594c5515457aa4f9219294d65738074f9e022d1a12d66cd2587',
  'budget_accounts.budget_accounts_period_bounds_ck':
    '1421c90856bafed713647634abfde6b4f1dc8046a7e6b304684ed7d01eaa6ae1',
  'budget_accounts.budget_accounts_period_ck':
    'c6f66b6d97cd2ef186e8247c0af328861046f9789fa5118d12a6e4f4f4dcbb34',
  'budget_accounts.budget_accounts_scope_ck':
    'f1ca93f0ea477577c5683cc6fdd72eabf0f475f482b298418292cc9dc81d72ff',
  'budget_accounts.budget_accounts_snapshot_ck':
    '237a0fe10d65a5317a995369b91188da0bbf1b2fde1f01be27c48ee9904a4afc',
  'budget_accounts.budget_accounts_snapshot_hash_ck':
    '8af4ff1620b4f017aa9af9990a3c102afb127c01310730e9e2f50a6eab5b98ba',
  'budget_accounts.budget_accounts_timestamps_ck':
    'b27619f4b4b86a7b3a52fc45d2ea217982e0138d30a2685908c7f0d603394aba',
  'budget_accounts.budget_accounts_version_ck':
    '99d0130fa7be658080b9154ab451d81459d9000d0f30657413088261940eeb1a',
  'budget_cost_event_outbox.budget_cost_event_outbox_attempt_time_ck':
    '8e2cc224f754d2c866adcf36b3c3c5b1a636b3702fe5c6c634cc0b8eb6f0fadc',
  'budget_cost_event_outbox.budget_cost_event_outbox_attempts_ck':
    'bb9efdecbeb655b256884322a551f69cf1f9de6801cecf718ff9ba0350c646fb',
  'budget_cost_event_outbox.budget_cost_event_outbox_error_ck':
    'cfadb3465f273851854a857479e6a721121a3431b20a5f38595c6c86a91f3c77',
  'budget_cost_event_outbox.budget_cost_event_outbox_lifecycle_ck':
    'bbdf0ccec1b9c0705d1adf66d90e331db032c2f1b3e0af6fe70c852e4e888381',
  'budget_cost_event_outbox.budget_cost_event_outbox_payload_ck':
    'd6a8f6c23184795a43d3312b9d4afc87ea90672000f5ba6eb92095bae4b52fef',
  'budget_cost_event_outbox.budget_cost_event_outbox_status_ck':
    'aba3d685ce0b84f7ab349c2258e31c7bdb9eb0df006c4ce0011811a45cd4a43a',
  'budget_control_cutovers.budget_control_cutovers_lifecycle_ck':
    '80132a62c9ec9f8f3e3011e67884a2efa6b4c8ad8561dbbc005c85a5abf82ce1',
  'budget_control_cutovers.budget_control_cutovers_mode_ck':
    'd17a6bf322fba73690ebb64e13d36f0ed20a2fc7a28673b156bd1b7f2b327d1e',
  'budget_control_cutovers.budget_control_cutovers_reconciliation_ck':
    'b92a509df23a822f7f87fac6084ba2306a1d4d3edfd9b0231d90c6cf3af50c94',
  'budget_control_cutovers.budget_control_cutovers_ready_order_ck':
    'e74b8b287f5a4bcaa7fb2fcac3d30288f30daa79dab988aa40f8bdc90564fdd7',
  'budget_control_cutovers.budget_control_cutovers_status_ck':
    '85b5317ca5ff60fb3f44fc22a5fcd63ffbd0fba40de11f7883d8c8cdb98d41e6',
  'budget_control_cutovers.budget_control_cutovers_timestamps_ck':
    'ae31ee2ee84a2ce51e03cae2c0339817e314f106f1d751379fdbc20e937747cf',
  'budget_reservation_allocations.budget_reservation_allocations_account_version_ck':
    'd01fd28a3b963e0e8bbb82daae92088f71e2a322f8f9129e9f3dd5e9ebb088d5',
  'budget_reservation_allocations.budget_reservation_allocations_amounts_ck':
    '5cab9b59a83a0db2364398b17f7a99a30b8d141babedb9cee8c6837178111e60',
  'budget_reservation_allocations.budget_reservation_allocations_authorization_ck':
    '1a89cd9660166615e4ee8dcd61c50e2e7a07cc2021e0dda0c60df7f568b7b6c1',
  'budget_reservation_allocations.budget_reservation_allocations_control_result_ck':
    'e7804aac6b2bb42abfb2ac70074ddf471f5ba0ea94347235c31675b4533e09be',
  'budget_reservation_allocations.budget_reservation_allocations_deciding_ck':
    '3cd7d2cb8237c32b5fe0d853292e8027b518eaa812ec3a32c1cd6adeb0280f6b',
  'budget_reservation_allocations.budget_reservation_allocations_decision_math_ck':
    '1ab7abaa7de1a085c96bdccf9e7ed7b1bb365dc1e87143bde96ce3c761196c43',
  'budget_reservation_allocations.budget_reservation_allocations_enforcement_ck':
    '241d17a3c1cb1594c5515457aa4f9219294d65738074f9e022d1a12d66cd2587',
  'budget_reservation_allocations.budget_reservation_allocations_held_ck':
    '45e9dc0d73a07bacb556dfe13fc0144e5f3242cd46f5fa401c7108ff3cf88281',
  'budget_reservation_allocations.budget_reservation_allocations_order_ck':
    'd83df467d7e971feccbcfc05fadfe81c0ccf3483c733b27b08cb1b4955b8d27b',
  'budget_reservation_allocations.budget_reservation_allocations_settlement_math_ck':
    '5a3b6996a0a0ff554fea844ebb55a19694e743d6850a378b851f71f70f8ed96c',
  'budget_reservation_allocations.budget_reservation_allocations_snapshot_ck':
    'd38b9096117355da7c8a628f4bedc6cf13d0d8a79346dc3887de4d261c181edd',
  'budget_reservation_allocations.budget_reservation_allocations_status_ck':
    '68685cf2abe51c4918107caf83ccdbffbe5dfea90b9d0ab58f8ae396c0623a43',
  'budget_reservation_allocations.budget_reservation_allocations_timestamps_ck':
    'b27619f4b4b86a7b3a52fc45d2ea217982e0138d30a2685908c7f0d603394aba',
  'budget_reservation_transitions.budget_reservation_transitions_expiry_ck':
    'fbb8ca241fa5346127054da8a8b6d5759593376afc1bd8fcf0237b36fe4de422',
  'budget_reservation_transitions.budget_reservation_transitions_extension_ck':
    '9402536f52d1a432372d7531c08f4907472f7d0085e6ab9ffa8be3d3dfa3e795',
  'budget_reservation_transitions.budget_reservation_transitions_release_reason_ck':
    '76506a9d6ed6c3bb0162d50e6c3fb0c73f4af8af96ca213a6cc06f4e329c7f6b',
  'budget_reservation_transitions.budget_reservation_transitions_snapshot_ck':
    'a1744a9f94745bb1b6c31ad3bc7feef5d3cb469141bc581346076f154ba9c6eb',
  'budget_reservation_transitions.budget_reservation_transitions_state_ck':
    'fb86ceea56f9a11bfcc0c222f0972eff5dc7aad7d6fe7a6b269d4f086d8a4234',
  'budget_reservation_transitions.budget_reservation_transitions_type_ck':
    'f218236318b541ad22e7f6622078e07f162022028b97990014c09c30b9cb9cf0',
  'budget_reservation_transitions.budget_reservation_transitions_version_ck':
    'a2466806373ce998db1ff9b00e777ea14e04a2dbc17d7a45a6341d5993f9ba66',
  'budget_reservations.budget_reservations_amounts_ck':
    '1692d672d20d40d8d82784c43e03a300a3a3f17c909eccfffed6024aeef20b9d',
  'budget_reservations.budget_reservations_authorization_tx_ck':
    '66934d98309381e895bc8dc465d2c3b153779bd7c92c6f0f985684259376e944',
  'budget_reservations.budget_reservations_customer_id_ck':
    '733d5949a35cc8b14abd78ffebcf0f574c07cc23e1510714803c7c43deee2edc',
  'budget_reservations.budget_reservations_decision_ck':
    '30ef19ddfebdc7107a62109abcc41b1d54a4612b4f8a274383844fc558f530ce',
  'budget_reservations.budget_reservations_decision_reason_ck':
    '5cd5589d2613cbe4d998e68133368e5a6fbb62f06c52ccde34a7b8486dd1f79e',
  'budget_reservations.budget_reservations_decision_state_ck':
    'e0400546eded6e8459e2261afe4775a26e727ed79e8b902a6dd179d15f61fbf4',
  'budget_reservations.budget_reservations_framework_ck':
    'fa7bd0c25f874262009251b9cb413eb9d8a12d6bb41b1522ca4f6e2d1f26a933',
  'budget_reservations.budget_reservations_identifiers_ck':
    '7530502fab915afe89be1b6fa358ace9d21f6f897e7bad5e3465c2596e48534e',
  'budget_reservations.budget_reservations_kind_ck':
    'e01f20198a7d580586fb21d8f6a8871298e8d636b92a694da182ee64a9fa3bc7',
  'budget_reservations.budget_reservations_lifecycle_timestamps_ck':
    'd347d3ee8509c253bb6f406384d0621e253bbd039616d6fa318a116ae223bd27',
  'budget_reservations.budget_reservations_mode_ck':
    '380d88193007da3d4b6bd64b8ab3af423da4a7bcaa60584c8751b1c6f716584f',
  'budget_reservations.budget_reservations_mode_decision_ck':
    '37dcb695387abdd4b44c31cc2fa940ddb83a475a2bd45cb6648096c242789b1f',
  'budget_reservations.budget_reservations_pricing_snapshot_ck':
    'aa30aaf27fad33b18f3a10cb924f6f9c2de29323a3213a81505cc36c9d380de8',
  'budget_reservations.budget_reservations_request_hash_ck':
    '643a5f79d0927da4fb783885f3f505dc5dcc085d6698bfda051ac03d17b4c42b',
  'budget_reservations.budget_reservations_request_snapshot_ck':
    '81b263c874d36b350268cf9925c61f53a2f7b8f79292f8e6f2b0bec3363f2e60',
  'budget_reservations.budget_reservations_response_snapshot_ck':
    '05db330d2d2ff4c7f51ea1fd7d5186faaf6b8829f3f28ee76e0d70028b3e6948',
  'budget_reservations.budget_reservations_rule_set_ck':
    'cf5ec395e713e10555c76a057d1c8e0ffe0edb03c44f91b4431bcfc4700b45f4',
  'budget_reservations.budget_reservations_schema_version_ck':
    '7beb306ac1d62aa5336469458dc99a58693b957a800d5713ac66c25e52d6c4c8',
  'budget_reservations.budget_reservations_settlement_math_ck':
    'a4c80cfa0a45988140b72ecdd9309bac1d0bbba9ec0b0aa781332b98ac22cb35',
  'budget_reservations.budget_reservations_state_ck':
    '95b59fbf94925bc562f7ba5ec6c8957776fe0035e841b0069a31e35deae8a483',
  'budget_reservations.budget_reservations_state_version_ck':
    '8d7b60525ebad7fae0d918fdd1c80bee390467277533d7a982d5fcaac671348a',
  'budget_reservations.budget_reservations_ttl_ck':
    'a384709598e4408a360b3c1a4e2eaee2aa8fd22a9c17edef3754463793dea93f',
  'budget_reservations.budget_reservations_usage_bounds_ck':
    '177ef93bdf521eec9b12ecfd8dbab3609a1dd28351ba06bfc197b44f24fb574e',
  'budget_reservations.budget_reservations_usage_shape_ck':
    '85f2396a19a8b45bf4cdb4090ca6f9e3c4d17be97d07ab2e8658a351bde3af59',
  'budget_rule_revisions.budget_rule_revisions_amount_ck':
    '6a17737693fb14b29c12f701f40859f6fa463fa37ed0851e8a5ccceea7d8d5c9',
  'budget_rule_revisions.budget_rule_revisions_authority_order_ck':
    '74125e5fc0acd50770e92f78c3037f7e02683bfe471422db245b81b07c646961',
  'budget_rule_revisions.budget_rule_revisions_enforcement_ck':
    '241d17a3c1cb1594c5515457aa4f9219294d65738074f9e022d1a12d66cd2587',
  'budget_rule_revisions.budget_rule_revisions_lifecycle_ck':
    '511cd32f91c36a0b47a9218b84a7b2d42b724f95365313706cc56ecb133f39be',
  'budget_rule_revisions.budget_rule_revisions_period_ck':
    'c6f66b6d97cd2ef186e8247c0af328861046f9789fa5118d12a6e4f4f4dcbb34',
  'budget_rule_revisions.budget_rule_revisions_revision_ck':
    '5d3c40c7ab0a35b203a1f222edc869abf61c8b2261318ce397b7596999c9f72b',
  'budget_rule_revisions.budget_rule_revisions_scope_ck':
    'f1ca93f0ea477577c5683cc6fdd72eabf0f475f482b298418292cc9dc81d72ff',
  'budget_rule_revisions.budget_rule_revisions_snapshot_ck':
    '33f2a933efe2aac16984545a5b07564a40c760b80a86fcd18d51cd1c4b75cf81',
  'budget_rule_revisions.budget_rule_revisions_target_ck':
    'f4a97c504090681ab7918305da15b6de61d945f64afe23b38af03e0f4928747a',
  'budget_usage_ledger.budget_usage_ledger_customer_id_ck':
    '733d5949a35cc8b14abd78ffebcf0f574c07cc23e1510714803c7c43deee2edc',
  'budget_usage_ledger.budget_usage_ledger_framework_ck':
    'fa7bd0c25f874262009251b9cb413eb9d8a12d6bb41b1522ca4f6e2d1f26a933',
  'budget_usage_ledger.budget_usage_ledger_identifiers_ck':
    '7530502fab915afe89be1b6fa358ace9d21f6f897e7bad5e3465c2596e48534e',
  'budget_usage_ledger.budget_usage_ledger_kind_ck':
    'e01f20198a7d580586fb21d8f6a8871298e8d636b92a694da182ee64a9fa3bc7',
  'budget_usage_ledger.budget_usage_ledger_metadata_ck':
    '8b962c23133e65391e15a4c37c3301473ed6d6ff3da6cb24718dc08fc9663779',
  'budget_usage_ledger.budget_usage_ledger_projection_shape_ck':
    '43ea0baf0e631f863d184e786a8763ddfb14548fed2adafdd60e500db2818554',
  'budget_usage_ledger.budget_usage_ledger_retention_ck':
    'e5782197ddcf27dded4545e3441abd5c9be98d861945fc75963ce6457a6c7a70',
  'budget_usage_ledger.budget_usage_ledger_sdk_identity_ck':
    'ad8a444b9d06175bf9908fe79425bb79c181591627fdfd6e742fa1321a02f9ee',
  'budget_usage_ledger.budget_usage_ledger_snapshots_ck':
    '5e9a7840d1aa0818006484dcda42700a2d480028bc7aff31478fc37ead695699',
  'budget_usage_ledger.budget_usage_ledger_status_ck':
    '1ae1571cd37edf6dca0eb0db1064b15be8ef761daee48a89460d78cf9f0abb52',
  'budget_usage_ledger.budget_usage_ledger_usage_bounds_ck':
    '96dc0c012025ff12478b25b3033a4400eb25705f066368fcf1c5c97dd07aa163',
  'budget_usage_ledger.budget_usage_ledger_usage_shape_ck':
    '99520b21bba72e02710ec0999cd288a7c4661e673c2ed56443e7b8ef7fc9649f',
};

interface ExpectedLedgerKey {
  columns: readonly string[];
  constraint_name: string;
  constraint_type: 'PRIMARY KEY' | 'UNIQUE';
  nulls_not_distinct: boolean;
  table_name: string;
}

function ledgerKey(
  table_name: string,
  constraint_name: string,
  constraint_type: ExpectedLedgerKey['constraint_type'],
  columns: readonly string[],
  nulls_not_distinct = false,
): ExpectedLedgerKey {
  return { columns, constraint_name, constraint_type, nulls_not_distinct, table_name };
}

export const AUTHORITATIVE_BUDGET_REQUIRED_KEYS: readonly ExpectedLedgerKey[] = [
  ledgerKey(
    'budget_account_opening_evidence',
    'budget_account_opening_evidence_pk',
    'PRIMARY KEY',
    ['builder_id', 'account_id'],
  ),
  ledgerKey('budget_accounts', 'budget_accounts_pk', 'PRIMARY KEY', ['builder_id', 'id']),
  ledgerKey('budget_accounts', 'budget_accounts_rule_identity_uk', 'UNIQUE', [
    'builder_id',
    'id',
    'rule_key',
  ]),
  ledgerKey(
    'budget_accounts',
    'budget_accounts_natural_identity_uk',
    'UNIQUE',
    ['builder_id', 'rule_key', 'scope', 'subject_customer_id', 'period', 'period_start'],
    true,
  ),
  ledgerKey('budget_rule_revisions', 'budget_rule_revisions_pk', 'PRIMARY KEY', [
    'builder_id',
    'id',
  ]),
  ledgerKey('budget_rule_revisions', 'budget_rule_revisions_rule_revision_uk', 'UNIQUE', [
    'builder_id',
    'rule_key',
    'revision',
  ]),
  ledgerKey('budget_rule_revisions', 'budget_rule_revisions_allocation_identity_uk', 'UNIQUE', [
    'builder_id',
    'id',
    'rule_key',
  ]),
  ledgerKey('budget_rule_revisions', 'budget_rule_revisions_authority_order_uk', 'UNIQUE', [
    'authority_order',
  ]),
  ledgerKey('budget_reservations', 'budget_reservations_pk', 'PRIMARY KEY', [
    'builder_id',
    'decision_id',
  ]),
  ledgerKey('budget_reservations', 'budget_reservations_operation_uk', 'UNIQUE', [
    'builder_id',
    'operation_id',
  ]),
  ledgerKey('budget_reservations', 'budget_reservations_usage_parent_uk', 'UNIQUE', [
    'builder_id',
    'decision_id',
    'operation_id',
  ]),
  ledgerKey('budget_reservation_allocations', 'budget_reservation_allocations_pk', 'PRIMARY KEY', [
    'builder_id',
    'id',
  ]),
  ledgerKey(
    'budget_reservation_allocations',
    'budget_reservation_allocations_account_uk',
    'UNIQUE',
    ['builder_id', 'reservation_decision_id', 'account_id'],
  ),
  ledgerKey('budget_reservation_allocations', 'budget_reservation_allocations_rule_uk', 'UNIQUE', [
    'builder_id',
    'reservation_decision_id',
    'rule_key',
  ]),
  ledgerKey('budget_reservation_allocations', 'budget_reservation_allocations_order_uk', 'UNIQUE', [
    'builder_id',
    'reservation_decision_id',
    'evaluation_order',
  ]),
  ledgerKey('budget_reservation_transitions', 'budget_reservation_transitions_pk', 'PRIMARY KEY', [
    'builder_id',
    'id',
  ]),
  ledgerKey('budget_usage_ledger', 'budget_usage_ledger_pk', 'PRIMARY KEY', ['builder_id', 'id']),
  ledgerKey('budget_usage_ledger', 'budget_usage_ledger_decision_uk', 'UNIQUE', [
    'builder_id',
    'reservation_decision_id',
  ]),
  ledgerKey('budget_usage_ledger', 'budget_usage_ledger_operation_uk', 'UNIQUE', [
    'builder_id',
    'operation_id',
  ]),
  ledgerKey('budget_usage_ledger', 'budget_usage_ledger_cost_event_uk', 'UNIQUE', [
    'builder_id',
    'cost_event_id',
  ]),
  ledgerKey('budget_usage_ledger', 'budget_usage_ledger_outbox_parent_uk', 'UNIQUE', [
    'builder_id',
    'id',
    'cost_event_id',
  ]),
  ledgerKey('budget_cost_event_outbox', 'budget_cost_event_outbox_pk', 'PRIMARY KEY', [
    'builder_id',
    'id',
  ]),
  ledgerKey('budget_cost_event_outbox', 'budget_cost_event_outbox_usage_uk', 'UNIQUE', [
    'builder_id',
    'usage_ledger_id',
  ]),
  ledgerKey('budget_cost_event_outbox', 'budget_cost_event_outbox_event_uk', 'UNIQUE', [
    'builder_id',
    'cost_event_id',
  ]),
  ledgerKey('budget_control_cutovers', 'budget_control_cutovers_pkey', 'PRIMARY KEY', [
    'builder_id',
  ]),
];

function ledgerChecks(
  table_name: string,
  constraintNames: readonly string[],
): ExpectedLedgerCheck[] {
  return constraintNames.map((constraint_name) => {
    const identity = `${table_name}.${constraint_name}`;
    const definition_hash = AUTHORITATIVE_BUDGET_CHECK_DEFINITION_HASHES[identity];
    if (definition_hash === undefined) {
      throw new Error(`Missing authoritative CHECK fingerprint for ${identity}`);
    }
    return { constraint_name, definition_hash, table_name };
  });
}

export const AUTHORITATIVE_BUDGET_REQUIRED_CHECKS: readonly ExpectedLedgerCheck[] = [
  ...ledgerChecks('budget_account_opening_evidence', [
    'budget_account_opening_evidence_source_ck',
    'budget_account_opening_evidence_amount_ck',
    'budget_account_opening_evidence_snapshot_ck',
    'budget_account_opening_evidence_timestamps_ck',
  ]),
  ...ledgerChecks('budget_accounts', [
    'budget_accounts_scope_ck',
    'budget_accounts_enforcement_ck',
    'budget_accounts_customer_scope_ck',
    'budget_accounts_period_ck',
    'budget_accounts_period_bounds_ck',
    'budget_accounts_snapshot_ck',
    'budget_accounts_snapshot_hash_ck',
    'budget_accounts_amounts_ck',
    'budget_accounts_timestamps_ck',
    'budget_accounts_version_ck',
  ]),
  ...ledgerChecks('budget_rule_revisions', [
    'budget_rule_revisions_revision_ck',
    'budget_rule_revisions_scope_ck',
    'budget_rule_revisions_target_ck',
    'budget_rule_revisions_period_ck',
    'budget_rule_revisions_enforcement_ck',
    'budget_rule_revisions_snapshot_ck',
    'budget_rule_revisions_amount_ck',
    'budget_rule_revisions_authority_order_ck',
    'budget_rule_revisions_lifecycle_ck',
  ]),
  ...ledgerChecks('budget_reservations', [
    'budget_reservations_schema_version_ck',
    'budget_reservations_request_hash_ck',
    'budget_reservations_request_snapshot_ck',
    'budget_reservations_response_snapshot_ck',
    'budget_reservations_rule_set_ck',
    'budget_reservations_authorization_tx_ck',
    'budget_reservations_mode_ck',
    'budget_reservations_mode_decision_ck',
    'budget_reservations_kind_ck',
    'budget_reservations_customer_id_ck',
    'budget_reservations_framework_ck',
    'budget_reservations_identifiers_ck',
    'budget_reservations_ttl_ck',
    'budget_reservations_decision_ck',
    'budget_reservations_state_ck',
    'budget_reservations_usage_shape_ck',
    'budget_reservations_usage_bounds_ck',
    'budget_reservations_pricing_snapshot_ck',
    'budget_reservations_amounts_ck',
    'budget_reservations_decision_reason_ck',
    'budget_reservations_decision_state_ck',
    'budget_reservations_lifecycle_timestamps_ck',
    'budget_reservations_settlement_math_ck',
    'budget_reservations_state_version_ck',
  ]),
  ...ledgerChecks('budget_reservation_allocations', [
    'budget_reservation_allocations_snapshot_ck',
    'budget_reservation_allocations_enforcement_ck',
    'budget_reservation_allocations_status_ck',
    'budget_reservation_allocations_deciding_ck',
    'budget_reservation_allocations_order_ck',
    'budget_reservation_allocations_account_version_ck',
    'budget_reservation_allocations_held_ck',
    'budget_reservation_allocations_decision_math_ck',
    'budget_reservation_allocations_authorization_ck',
    'budget_reservation_allocations_amounts_ck',
    'budget_reservation_allocations_control_result_ck',
    'budget_reservation_allocations_settlement_math_ck',
    'budget_reservation_allocations_timestamps_ck',
  ]),
  ...ledgerChecks('budget_reservation_transitions', [
    'budget_reservation_transitions_type_ck',
    'budget_reservation_transitions_extension_ck',
    'budget_reservation_transitions_release_reason_ck',
    'budget_reservation_transitions_snapshot_ck',
    'budget_reservation_transitions_state_ck',
    'budget_reservation_transitions_version_ck',
    'budget_reservation_transitions_expiry_ck',
  ]),
  ...ledgerChecks('budget_usage_ledger', [
    'budget_usage_ledger_customer_id_ck',
    'budget_usage_ledger_framework_ck',
    'budget_usage_ledger_sdk_identity_ck',
    'budget_usage_ledger_identifiers_ck',
    'budget_usage_ledger_kind_ck',
    'budget_usage_ledger_usage_shape_ck',
    'budget_usage_ledger_usage_bounds_ck',
    'budget_usage_ledger_status_ck',
    'budget_usage_ledger_projection_shape_ck',
    'budget_usage_ledger_snapshots_ck',
    'budget_usage_ledger_metadata_ck',
    'budget_usage_ledger_retention_ck',
  ]),
  ...ledgerChecks('budget_cost_event_outbox', [
    'budget_cost_event_outbox_payload_ck',
    'budget_cost_event_outbox_status_ck',
    'budget_cost_event_outbox_attempts_ck',
    'budget_cost_event_outbox_error_ck',
    'budget_cost_event_outbox_lifecycle_ck',
    'budget_cost_event_outbox_attempt_time_ck',
  ]),
  ...ledgerChecks('budget_control_cutovers', [
    'budget_control_cutovers_status_ck',
    'budget_control_cutovers_mode_ck',
    'budget_control_cutovers_lifecycle_ck',
    'budget_control_cutovers_ready_order_ck',
    'budget_control_cutovers_reconciliation_ck',
    'budget_control_cutovers_timestamps_ck',
  ]),
];

interface ExpectedLedgerFunction {
  configuration: string;
  function_name: string;
  identity_arguments: string;
  language: string;
  parallel_safety: string;
  result_type: string;
  security_definer: boolean;
  source_hash: string;
  strict: boolean;
  volatility: string;
}

interface ExpectedDiscoveryFunction extends ExpectedLedgerFunction {
  acl_grantees: readonly string[];
  default_argument_count: number;
  function_kind: string;
  leakproof: boolean;
  owner_name: string;
  return_type_oid: string;
  returns_set: boolean;
}

export const AUTHORITATIVE_BUDGET_DISCOVERY_FUNCTIONS: readonly ExpectedDiscoveryFunction[] = [
  {
    acl_grantees: ['pylva_budget_control_runtime', 'pylva_budget_projection_discovery_owner'],
    configuration: 'search_path=pg_catalog',
    default_argument_count: 2,
    function_kind: 'FUNCTION',
    function_name: 'pylva_budget_projection_actionable_builders',
    identity_arguments: 'p_after_builder_id uuid, p_limit integer',
    language: 'plpgsql',
    leakproof: false,
    owner_name: 'pylva_budget_projection_discovery_owner',
    parallel_safety: 'UNSAFE',
    result_type: 'TABLE(builder_id uuid)',
    return_type_oid: 'uuid',
    returns_set: true,
    security_definer: true,
    source_hash: 'ec097d7039cac21aee4e5ae738a892e2d39f282badb8b070b253450f39d52132',
    strict: false,
    volatility: 'STABLE',
  },
  {
    acl_grantees: ['pylva_budget_control_runtime', 'pylva_budget_expiry_discovery_owner'],
    configuration: 'search_path=pg_catalog',
    default_argument_count: 2,
    function_kind: 'FUNCTION',
    function_name: 'pylva_budget_expiry_actionable_builders',
    identity_arguments: 'p_after_builder_id uuid, p_limit integer',
    language: 'plpgsql',
    leakproof: false,
    owner_name: 'pylva_budget_expiry_discovery_owner',
    parallel_safety: 'UNSAFE',
    result_type: 'TABLE(builder_id uuid)',
    return_type_oid: 'uuid',
    returns_set: true,
    security_definer: true,
    source_hash: 'c23d1e687a10f1b47103f402493dcccde9f62fb65408c3b4621a6ab5064a7f67',
    strict: false,
    volatility: 'STABLE',
  },
];

const AUTHORITATIVE_BUDGET_FUNCTION_SOURCE_HASHES: Readonly<Record<string, string>> = {
  'pylva_budget_account_postings_consistency_guard()':
    '58abdcedc7c66cf73c1e857f3b59a222f7c1ed7fa888a97480ddfa41f64313b6',
  'pylva_budget_account_opening_consistency_guard()':
    '59afcc7b44f26300fc42dd886dc9644b38043aece33ced34ea809b059c942896',
  'pylva_budget_accounts_immutability_guard()':
    'a1a2ee90f6240c91321784a5762bda5fe7624e7a581e08690c61efef45d22499',
  'pylva_budget_allocation_insert_guard()':
    '6c243dac0f22cf88043d2fb162e5c9a79ac748a2af62d0fc61eb04b9e1b46a17',
  'pylva_budget_allocation_postings_consistency_guard()':
    '639ff7e1b84533bb5a6fdc9e8a53227a0b280595d4c591d4110436cfb97447c4',
  'pylva_budget_allocation_reservation_consistency_guard()':
    '987364bd210d87b17e29410716ebf7d40738b7b0cb84ef08db266811157ba727',
  'pylva_budget_allocations_immutability_guard()':
    'a0ee275dfad6f7b8f2410f064571712e67b080d2ceab4ee4e5ac2db267428940',
  'pylva_budget_append_only_guard()':
    '0c49e45793a465bc98228be8ccab375f0546f471901d6636a47e49f73ae6a3e0',
  'pylva_budget_apply_allocation_posting()':
    'c77645a61563df01b07a02d44425f8d6a6af27d0fe51b4c81c770813a4c74d80',
  'pylva_budget_assert_account_postings(tenant_id uuid, budget_account_id uuid)':
    '173b49824576bd8af6d91f2894985179e9b1f2eba20198cf013c744a9beb4897',
  'pylva_budget_assert_account_opening_evidence(tenant_id uuid, stable_account_id uuid)':
    'dc41795c77ef8931b80897dabd595283ed75889974099dd91b761ea494e803ff',
  'pylva_budget_assert_reservation_allocations(tenant_id uuid, reservation_decision uuid, require_current_account_set boolean)':
    '963c2f2981cf369961c28c9d0be55b1c61580bed5d12dc676ca02afd13aaced1',
  'pylva_budget_assert_reservation_snapshots(tenant_id uuid, reservation_decision uuid)':
    'c8109d2e8c90538020818b7f8b3d127033494387682c0afa677f701a6ccd41d9',
  'pylva_budget_assert_reservation_readiness(tenant_id uuid, reservation_decision uuid)':
    '3be9bd8b57213d74e262d20c7932f28265a55fea1a8507f903940ebfedbaf787',
  'pylva_budget_assert_reservation_transitions(tenant_id uuid, reservation_decision uuid)':
    'd4cb12491e326abb960202715afa27e2662f7e6d18629ea859a8bc3e11e2d0f4',
  'pylva_budget_assert_retention_tombstone_pair(tenant_id uuid, usage_id uuid)':
    'a9facd07ca03c5176d7d98f2e0b64ef57944e4c15cb571863260c74e11fa8fae',
  'pylva_budget_assert_revision_successors(tenant_id uuid, stable_rule_key uuid)':
    '94617a32c8ff67f3750629de0a1815b5d98b3a03c2da1326939e1635925cac6e',
  'pylva_budget_cost_event_payload(usage_row budget_usage_ledger)':
    '51d84c6b0d9c6978fa9cad54ce4a2f51fae56d25c7fc00c91ea7266265e0afd5',
  'pylva_budget_builder_next_activation_boundary(tenant_id uuid, activation_anchor timestamp with time zone)':
    '286b65f9507c03bbf681fb3dc84a5c8a70e74b889696f3166972fb93a171aa2a',
  'pylva_budget_cutovers_guard()':
    '5bbd8879320733f156223baa185f69d184fed9f4f48380160a17a2eb73371cc6',
  'pylva_budget_decimal_text(value numeric)':
    '2baa3a4fcbdadad1c36bfb58fcd7b0049d18dce409aa2c6a224405a8ccc41d30',
  'pylva_budget_jsonb_sha256(value jsonb)':
    '0bf2ea7466e630364308902d97774210035d8fea2b2fd2b58e652f33bc464660',
  'pylva_budget_jsonb_uuid_matches(value jsonb, expected uuid)':
    '38321216ba329a827b8d62290c0fb49b39dcce10fbbcc2989df24f1326062998',
  'pylva_budget_outbox_immutability_guard()':
    'd70c603620baa7282eacfc7ea7ba3f81f675e0e701c41cf581c6295e09bd6fa6',
  'pylva_budget_outbox_retention_pair_guard()':
    'fffb2f916fd55fe0b4959e4d082ec4ff67279b8d4b9990eab460bc72a910c56f',
  'pylva_budget_next_period_boundary(period_name text, reference_time timestamp with time zone)':
    '75b05aaa54e7769261f1a596bf71efb97c7fe26b2c5dc08ad0a823175b9f868e',
  'pylva_budget_opening_evidence_consistency_guard()':
    '729d88a15ebd8a1375d4d6c2696594b5c8d25818673c59990d7b8cfe1b618fb4',
  'pylva_budget_opening_evidence_guard()':
    'c938086c42f57a7c37ab3fddf3e9760bb168113649e45a1337ff9ef4c4a1ff31',
  'pylva_budget_reservation_allocations_consistency_guard()':
    'a572af128b08c3b26145481a676b4bc91ee87e4fddfe9d96639c1e86eeddc5ca',
  'pylva_budget_reservation_readiness_consistency_guard()':
    'f0d8711d9226b99556c19f62747a2fd949efb80bb3669d6e74f4b3edba85272f',
  'pylva_budget_reservation_transition_consistency_guard()':
    '5e9c3fe2ddaa5425e7ff31135612bb65d201cc4863df4468d5dd6e3a7a3ad350',
  'pylva_budget_reservation_usage_consistency_guard()':
    '6c54d01af176f4220734ba069b93647f4b5ec43039bfbae6b5771911c0e1731d',
  'pylva_budget_reservations_immutability_guard()':
    'cc090e7f3f169a3e138a28cf76f753f39a74521378918d11bb091ccf5634ac50',
  'pylva_budget_revision_successor_consistency_guard()':
    'b0fd7b59488c051acb3f1b54194f864a208d8431f59bd4dedbb100e9ec987d44',
  'pylva_budget_rule_revision_authority_order_guard()':
    'b7efe6660fc9289a3a2c352d935f9afa0b21ef83d991caa6fb16fb1b4d03a90b',
  'pylva_budget_rule_revisions_immutability_guard()':
    '74c34e162f5fa14b4cd77a1bb645819dd7cb8aa9241e667ec6a46c65effa2f66',
  'pylva_budget_timestamp_is_wire_safe(value timestamp with time zone)':
    'd268b1a320dba0f39a58a5c738e6f23b0cedfafe8cd780da26db03d976b217c8',
  'pylva_budget_timestamp_text(value timestamp with time zone)':
    'fa263ded22203b87ac71569b91f3152acd6562e84ba8cd5851ae54d67931934b',
  'pylva_budget_transition_parent_consistency_guard()':
    'abf6b2c6630d32f15a585b72c07e9c7b6bbeaa02f8481f825d062e5d3fbaf205',
  'pylva_budget_usage_immutability_guard()':
    '3c0972079e2b5b7b7cb0611a8675a1533300714eb328d8c672abf74ef9e0b123',
  'pylva_budget_usage_parent_consistency_guard()':
    'b4fbb022c745178406de3a21d12eff6ef3d5861969e41d6cad4c45155243aa5d',
  'pylva_budget_usage_retention_pair_guard()':
    '2158011a73a27a5e5db494b16ca7a91c6f2eacd04298162387d494b0c8a6da86',
  'pylva_budget_uuid_array_is_canonical(value uuid[])':
    '9960fd8c90dc558c8c8042780c0d92a98d8775e56dda3c49a31ab6611047517d',
};

function ledgerFunction(
  function_name: string,
  identity_arguments: string,
  result_type: string,
  immutable = false,
  configuration = 'search_path=pg_catalog,public',
  strict = immutable,
): ExpectedLedgerFunction {
  const identity = `${function_name}(${identity_arguments})`;
  const source_hash = AUTHORITATIVE_BUDGET_FUNCTION_SOURCE_HASHES[identity];
  if (source_hash === undefined) {
    throw new Error(`Missing authoritative helper fingerprint for ${identity}`);
  }
  return {
    configuration,
    function_name,
    identity_arguments,
    language: immutable ? 'sql' : 'plpgsql',
    parallel_safety: immutable ? 'SAFE' : 'UNSAFE',
    result_type,
    security_definer: false,
    source_hash,
    strict,
    volatility: immutable ? 'IMMUTABLE' : 'VOLATILE',
  };
}

function ledgerFunctionExact(
  expected: Omit<ExpectedLedgerFunction, 'source_hash'>,
): ExpectedLedgerFunction {
  const identity = `${expected.function_name}(${expected.identity_arguments})`;
  const source_hash = AUTHORITATIVE_BUDGET_FUNCTION_SOURCE_HASHES[identity];
  if (source_hash === undefined) {
    throw new Error(`Missing authoritative helper fingerprint for ${identity}`);
  }
  return { ...expected, source_hash };
}

export const AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS: readonly ExpectedLedgerFunction[] = [
  ledgerFunction('pylva_budget_jsonb_sha256', 'value jsonb', 'text', true),
  ledgerFunction(
    'pylva_budget_decimal_text',
    'value numeric',
    'text',
    true,
    'search_path=pg_catalog',
  ),
  ledgerFunction(
    'pylva_budget_jsonb_uuid_matches',
    'value jsonb, expected uuid',
    'boolean',
    true,
    'search_path=pg_catalog',
    false,
  ),
  ledgerFunction(
    'pylva_budget_uuid_array_is_canonical',
    'value uuid[]',
    'boolean',
    true,
    'search_path=pg_catalog',
  ),
  ledgerFunction(
    'pylva_budget_timestamp_text',
    'value timestamp with time zone',
    'text',
    true,
    'search_path=pg_catalog',
  ),
  ledgerFunction(
    'pylva_budget_timestamp_is_wire_safe',
    'value timestamp with time zone',
    'boolean',
    true,
    'search_path=pg_catalog',
  ),
  ledgerFunction('pylva_budget_cost_event_payload', 'usage_row budget_usage_ledger', 'jsonb', true),
  ledgerFunctionExact({
    configuration: 'search_path=pg_catalog',
    function_name: 'pylva_budget_next_period_boundary',
    identity_arguments: 'period_name text, reference_time timestamp with time zone',
    language: 'sql',
    parallel_safety: 'SAFE',
    result_type: 'timestamp with time zone',
    security_definer: false,
    strict: true,
    volatility: 'IMMUTABLE',
  }),
  ledgerFunctionExact({
    configuration: 'search_path=pg_catalog,public',
    function_name: 'pylva_budget_builder_next_activation_boundary',
    identity_arguments: 'tenant_id uuid, activation_anchor timestamp with time zone',
    language: 'plpgsql',
    parallel_safety: 'UNSAFE',
    result_type: 'timestamp with time zone',
    security_definer: false,
    strict: false,
    volatility: 'STABLE',
  }),
  ledgerFunction('pylva_budget_cutovers_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_reservation_readiness',
    'tenant_id uuid, reservation_decision uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_reservation_readiness_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_opening_evidence_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_account_opening_evidence',
    'tenant_id uuid, stable_account_id uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_account_opening_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_opening_evidence_consistency_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_reservation_snapshots',
    'tenant_id uuid, reservation_decision uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_accounts_immutability_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_rule_revisions_immutability_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_rule_revision_authority_order_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_revision_successors',
    'tenant_id uuid, stable_rule_key uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_revision_successor_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_reservations_immutability_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_allocation_insert_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_allocations_immutability_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_apply_allocation_posting', '', 'trigger'),
  ledgerFunction('pylva_budget_append_only_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_usage_immutability_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_usage_parent_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_reservation_usage_consistency_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_retention_tombstone_pair',
    'tenant_id uuid, usage_id uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_usage_retention_pair_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_outbox_retention_pair_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_reservation_transitions',
    'tenant_id uuid, reservation_decision uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_reservation_transition_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_transition_parent_consistency_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_reservation_allocations',
    'tenant_id uuid, reservation_decision uuid, require_current_account_set boolean',
    'void',
  ),
  ledgerFunction('pylva_budget_reservation_allocations_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_allocation_reservation_consistency_guard', '', 'trigger'),
  ledgerFunction(
    'pylva_budget_assert_account_postings',
    'tenant_id uuid, budget_account_id uuid',
    'void',
  ),
  ledgerFunction('pylva_budget_account_postings_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_allocation_postings_consistency_guard', '', 'trigger'),
  ledgerFunction('pylva_budget_outbox_immutability_guard', '', 'trigger'),
];

type PhysicalSchemaSqlClient = Pick<MigrateSqlClient, 'unsafe'>;
export type PhysicalSchemaContract = (typeof PHYSICAL_SCHEMA_CONTRACTS)[number];

export interface VerifyPhysicalSchemaArgs {
  contract: PhysicalSchemaContract;
  json: boolean;
}

export interface PhysicalScopeConstraint {
  definition: string;
  name: string;
  validated: boolean;
}

export interface PhysicalSchemaContractResult {
  constraint: PhysicalScopeConstraint | null;
  constraint_scope_values: string[];
  ledger: Array<{
    checksum_matches: boolean;
    filename: string;
    present: boolean;
  }>;
  ok: boolean;
  scope_distribution: Array<{ count: string; scope: string }>;
  unexpected_constraints: string[];
  unexpected_scope_values: string[];
}

export interface PhysicalNumericColumn {
  column_name: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
  table_name: string;
}

export interface PhysicalLedgerColumn {
  column_name: string;
  data_type: string;
  default_expression: string | null;
  default_kind: string;
  nullable: boolean;
  table_name: string;
}

export interface PhysicalLedgerCheck {
  constraint_name: string;
  definition_hash: string;
  table_name: string;
  validated: boolean;
}

export interface PhysicalLedgerFunction {
  configuration: string;
  function_name: string;
  identity_arguments: string;
  language: string;
  parallel_safety: string;
  result_type: string;
  security_definer: boolean;
  source_hash: string;
  strict: boolean;
  volatility: string;
}

export interface PhysicalDiscoveryFunction extends PhysicalLedgerFunction {
  acl_grantees: string[];
  acl_is_exact: boolean;
  default_argument_count: number;
  function_kind: string;
  leakproof: boolean;
  owner_name: string;
  return_type_oid: string;
  returns_set: boolean;
}

export interface PhysicalBudgetRuntimeSecurity {
  discovery_owner_acl_safe: boolean;
  discovery_owner_memberships_safe: boolean;
  fixed_role_attributes_safe: boolean;
  general_app_default_acl_safe: boolean;
  general_app_effective_acl_safe: boolean;
  general_app_fixed_role_attributes_safe: boolean;
  general_app_login_attributes_and_ownership_safe: boolean;
  general_app_login_column_acl_safe: boolean;
  general_app_login_direct_acl_safe: boolean;
  general_app_memberships_safe: boolean;
  general_app_ownership_safe: boolean;
  general_app_partition_function_safe: boolean;
  public_acl_safe: boolean;
  runtime_acl_safe: boolean;
}

export interface PhysicalLedgerKey {
  columns: string[];
  constraint_name: string;
  constraint_type: string;
  nulls_not_distinct: boolean;
  table_name: string;
  validated: boolean;
}

export interface PhysicalRlsTable {
  rls_enabled: boolean;
  rls_forced: boolean;
  table_name: string;
}

export interface PhysicalTenantPolicy {
  command: string;
  permissive: boolean;
  policy_name: string;
  roles: string[];
  table_name: string;
  using_expression: string | null;
  with_check_expression: string | null;
}

export interface PhysicalTenantForeignKey {
  child_columns: string[];
  child_table: string;
  constraint_name: string;
  deferrable: boolean;
  delete_action: string;
  initially_deferred: boolean;
  match_type: string;
  parent_columns: string[];
  parent_table: string;
  update_action: string;
  validated: boolean;
}

export interface PhysicalLedgerIndex {
  access_method: string;
  definition: string;
  descending_columns: string[];
  included_columns: string[];
  index_name: string;
  key_columns: string[];
  nulls_not_distinct: boolean;
  nulls_first_columns: string[];
  predicate: string | null;
  ready: boolean;
  table_name: string;
  unique: boolean;
  valid: boolean;
}

export interface PhysicalImmutabilityTrigger {
  before: boolean;
  constraint_trigger: boolean;
  deferrable: boolean;
  definition: string;
  delete_event: boolean;
  enabled: boolean;
  function_name: string;
  function_schema: string;
  initially_deferred: boolean;
  insert_event: boolean;
  row_level: boolean;
  table_name: string;
  trigger_name: string;
  truncate_event: boolean;
  update_event: boolean;
}

export interface PhysicalLedgerSequence {
  cache_size: string;
  cycle: boolean;
  data_type: string;
  increment_by: string;
  max_value: string;
  min_value: string;
  owned_by_column: boolean;
  owner_name: string;
  public_has_no_privileges: boolean;
  sequence_name: string;
  start_value: string;
}

export interface PhysicalObjectCheck<T> {
  actual: T[];
  invalid: string[];
  missing: string[];
  unexpected: string[];
}

export interface AuthoritativeBudgetLedgerContractResult {
  account_nulls_not_distinct: PhysicalObjectCheck<PhysicalLedgerIndex>;
  columns: PhysicalObjectCheck<PhysicalLedgerColumn>;
  check_constraints: PhysicalObjectCheck<PhysicalLedgerCheck>;
  contract: typeof AUTHORITATIVE_BUDGET_LEDGER_CONTRACT;
  discovery_functions: PhysicalObjectCheck<PhysicalDiscoveryFunction>;
  immutability_triggers: PhysicalObjectCheck<PhysicalImmutabilityTrigger>;
  ledger: Array<{
    checksum_matches: boolean;
    filename: string;
    present: boolean;
  }>;
  helper_functions: PhysicalObjectCheck<PhysicalLedgerFunction>;
  key_constraints: PhysicalObjectCheck<PhysicalLedgerKey>;
  numeric_authority_columns: PhysicalObjectCheck<PhysicalNumericColumn>;
  ok: boolean;
  required_indexes: PhysicalObjectCheck<PhysicalLedgerIndex>;
  row_level_security: PhysicalObjectCheck<PhysicalRlsTable>;
  runtime_security: PhysicalBudgetRuntimeSecurity;
  sequences: PhysicalObjectCheck<PhysicalLedgerSequence>;
  schema_head: {
    actual: string | null;
    expected: typeof AUTHORITATIVE_BUDGET_SCHEMA_HEAD;
    matches: boolean;
  };
  tables: PhysicalObjectCheck<string>;
  tenant_foreign_keys: PhysicalObjectCheck<PhysicalTenantForeignKey>;
  tenant_policies: PhysicalObjectCheck<PhysicalTenantPolicy>;
}

export type VerifyPhysicalSchemaResult =
  | PhysicalSchemaContractResult
  | AuthoritativeBudgetLedgerContractResult;

const CONSTRAINT_QUERY = `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'api_keys'::regclass
  AND conname LIKE 'api_keys_scope%'
ORDER BY conname`;

const LEDGER_QUERY = `SELECT filename, checksum
FROM schema_migrations
WHERE filename = ANY($1::text[])
ORDER BY filename`;

const SCOPE_DISTRIBUTION_QUERY = `SELECT scope, count(*)::text AS count
FROM api_keys
GROUP BY scope
ORDER BY scope`;

const BUDGET_TABLES_QUERY = `/* ledger-contract:tables */
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND c.relname LIKE 'budget\\_%' ESCAPE '\\'
ORDER BY c.relname`;

const BUDGET_COLUMNS_QUERY = `/* ledger-contract:columns */
SELECT table_class.relname AS table_name,
       attribute.attname AS column_name,
       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
       (NOT attribute.attnotnull) AS nullable,
       pg_get_expr(default_catalog.adbin, default_catalog.adrelid) AS default_expression
FROM pg_attribute attribute
JOIN pg_class table_class ON table_class.oid = attribute.attrelid
JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
LEFT JOIN pg_attrdef default_catalog
  ON default_catalog.adrelid = attribute.attrelid
 AND default_catalog.adnum = attribute.attnum
WHERE table_namespace.nspname = 'public'
  AND table_class.relname = ANY($1::text[])
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY table_class.relname, attribute.attnum`;

const BUDGET_CHECKS_QUERY = `/* ledger-contract:checks */
SELECT table_class.relname AS table_name,
       constraint_catalog.conname AS constraint_name,
       constraint_catalog.convalidated AS validated,
       encode(
         digest(pg_get_constraintdef(constraint_catalog.oid), 'sha256'),
         'hex'
       ) AS definition_hash
FROM pg_constraint constraint_catalog
JOIN pg_class table_class ON table_class.oid = constraint_catalog.conrelid
JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
WHERE table_namespace.nspname = 'public'
  AND table_class.relname = ANY($1::text[])
  AND constraint_catalog.contype = 'c'
ORDER BY table_class.relname, constraint_catalog.conname`;

const BUDGET_KEYS_QUERY = `/* ledger-contract:keys */
SELECT table_class.relname AS table_name,
       constraint_catalog.conname AS constraint_name,
       CASE constraint_catalog.contype
         WHEN 'p' THEN 'PRIMARY KEY'
         WHEN 'u' THEN 'UNIQUE'
       END AS constraint_type,
       constraint_catalog.convalidated AS validated,
       index_catalog.indnullsnotdistinct AS nulls_not_distinct,
       string_agg(attribute.attname, ',' ORDER BY key_position.ordinality) AS columns
FROM pg_constraint constraint_catalog
JOIN pg_class table_class ON table_class.oid = constraint_catalog.conrelid
JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
JOIN pg_index index_catalog ON index_catalog.indexrelid = constraint_catalog.conindid
JOIN LATERAL unnest(constraint_catalog.conkey) WITH ORDINALITY
  AS key_position(attnum, ordinality) ON true
JOIN pg_attribute attribute
  ON attribute.attrelid = table_class.oid
 AND attribute.attnum = key_position.attnum
WHERE table_namespace.nspname = 'public'
  AND table_class.relname = ANY($1::text[])
  AND constraint_catalog.contype IN ('p', 'u')
GROUP BY table_class.relname,
         constraint_catalog.conname,
         constraint_catalog.contype,
         constraint_catalog.convalidated,
         index_catalog.indnullsnotdistinct
ORDER BY table_class.relname, constraint_catalog.conname`;

const BUDGET_FUNCTIONS_QUERY = `/* ledger-contract:functions */
SELECT function_catalog.proname AS function_name,
       pg_get_function_identity_arguments(function_catalog.oid) AS identity_arguments,
       pg_get_function_result(function_catalog.oid) AS result_type,
       language_catalog.lanname AS language,
       CASE function_catalog.provolatile
         WHEN 'i' THEN 'IMMUTABLE'
         WHEN 's' THEN 'STABLE'
         WHEN 'v' THEN 'VOLATILE'
       END AS volatility,
       function_catalog.proisstrict AS strict,
       function_catalog.prosecdef AS security_definer,
       CASE function_catalog.proparallel
         WHEN 's' THEN 'SAFE'
         WHEN 'r' THEN 'RESTRICTED'
         WHEN 'u' THEN 'UNSAFE'
       END AS parallel_safety,
       COALESCE(array_to_string(function_catalog.proconfig, ','), '') AS configuration,
       encode(digest(function_catalog.prosrc, 'sha256'), 'hex') AS source_hash
FROM pg_proc function_catalog
JOIN pg_namespace function_namespace ON function_namespace.oid = function_catalog.pronamespace
JOIN pg_language language_catalog ON language_catalog.oid = function_catalog.prolang
WHERE function_namespace.nspname = 'public'
  AND function_catalog.proname LIKE 'pylva_budget\\_%' ESCAPE '\\'
  AND function_catalog.proname NOT IN (
    'pylva_budget_projection_actionable_builders',
    'pylva_budget_expiry_actionable_builders'
  )
ORDER BY function_catalog.proname,
         pg_get_function_identity_arguments(function_catalog.oid)`;

const BUDGET_DISCOVERY_FUNCTIONS_QUERY = `/* ledger-contract:discovery-functions */
SELECT function_catalog.proname AS function_name,
       pg_catalog.pg_get_function_identity_arguments(function_catalog.oid)
         AS identity_arguments,
       pg_catalog.pg_get_function_result(function_catalog.oid) AS result_type,
       language_catalog.lanname AS language,
       CASE function_catalog.provolatile
         WHEN 'i' THEN 'IMMUTABLE'
         WHEN 's' THEN 'STABLE'
         WHEN 'v' THEN 'VOLATILE'
       END AS volatility,
       function_catalog.proisstrict AS strict,
       function_catalog.prosecdef AS security_definer,
       CASE function_catalog.proparallel
         WHEN 's' THEN 'SAFE'
         WHEN 'r' THEN 'RESTRICTED'
         WHEN 'u' THEN 'UNSAFE'
       END AS parallel_safety,
       COALESCE(pg_catalog.array_to_string(function_catalog.proconfig, ','), '')
         AS configuration,
       pg_catalog.encode(
         public.digest(function_catalog.prosrc, 'sha256'),
         'hex'
       ) AS source_hash,
       owner.rolname AS owner_name,
       CASE function_catalog.prokind
         WHEN 'f' THEN 'FUNCTION'
         WHEN 'p' THEN 'PROCEDURE'
         WHEN 'a' THEN 'AGGREGATE'
         WHEN 'w' THEN 'WINDOW'
       END AS function_kind,
       function_catalog.proretset AS returns_set,
       pg_catalog.format_type(function_catalog.prorettype, NULL) AS return_type_oid,
       function_catalog.pronargdefaults::pg_catalog.text AS default_argument_count,
       function_catalog.proleakproof AS leakproof,
       COALESCE((
         SELECT pg_catalog.string_agg(
                  CASE WHEN privilege.grantee = 0
                    THEN 'PUBLIC'
                    ELSE grantee.rolname
                  END,
                  ',' ORDER BY
                    CASE WHEN privilege.grantee = 0
                      THEN 'PUBLIC'
                      ELSE grantee.rolname
                    END
                )
         FROM pg_catalog.aclexplode(
           COALESCE(
             function_catalog.proacl,
             pg_catalog.acldefault('f', function_catalog.proowner)
           )
         ) AS privilege
         LEFT JOIN pg_catalog.pg_roles AS grantee
           ON grantee.oid = privilege.grantee
       ), '') AS acl_grantees,
       (
         SELECT pg_catalog.count(*) = 2
            AND pg_catalog.count(DISTINCT privilege.grantee) = 2
            AND pg_catalog.bool_and(
              privilege.privilege_type = 'EXECUTE'
              AND NOT privilege.is_grantable
              AND privilege.grantee IN (
                function_catalog.proowner,
                (
                  SELECT runtime.oid
                  FROM pg_catalog.pg_roles AS runtime
                  WHERE runtime.rolname = 'pylva_budget_control_runtime'
                )
              )
            )
         FROM pg_catalog.aclexplode(
           COALESCE(
             function_catalog.proacl,
             pg_catalog.acldefault('f', function_catalog.proowner)
           )
         ) AS privilege
       ) AS acl_is_exact
FROM pg_catalog.pg_proc AS function_catalog
JOIN pg_catalog.pg_namespace AS function_namespace
  ON function_namespace.oid = function_catalog.pronamespace
JOIN pg_catalog.pg_language AS language_catalog
  ON language_catalog.oid = function_catalog.prolang
JOIN pg_catalog.pg_roles AS owner
  ON owner.oid = function_catalog.proowner
WHERE function_namespace.nspname = 'public'
  AND function_catalog.proname IN (
    'pylva_budget_projection_actionable_builders',
    'pylva_budget_expiry_actionable_builders'
  )
ORDER BY function_catalog.proname,
         pg_catalog.pg_get_function_identity_arguments(function_catalog.oid)`;

const BUDGET_RUNTIME_SECURITY_QUERY = `/* ledger-contract:runtime-security */
WITH
fixed_roles AS (
  SELECT role.oid,
         role.rolname,
         role.rolcanlogin,
         role.rolinherit,
         role.rolsuper,
         role.rolbypassrls,
         role.rolcreatedb,
         role.rolcreaterole,
         role.rolreplication
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname IN (
    'pylva_budget_control_runtime',
    'pylva_budget_projection_discovery_owner',
    'pylva_budget_expiry_discovery_owner'
  )
),
runtime_role AS (
  SELECT *
  FROM fixed_roles
  WHERE rolname = 'pylva_budget_control_runtime'
),
discovery_owners AS (
  SELECT *
  FROM fixed_roles
  WHERE rolname IN (
    'pylva_budget_projection_discovery_owner',
    'pylva_budget_expiry_discovery_owner'
  )
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
runtime_function_acl AS (
  SELECT procedure.oid AS function_oid,
         privilege.privilege_type,
         privilege.is_grantable
  FROM pg_catalog.pg_proc AS procedure
  CROSS JOIN runtime_role AS runtime
  CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
  WHERE privilege.grantee = runtime.oid
),
expected_runtime_function_acl AS (
  SELECT discovery.projection_oid AS function_oid,
         'EXECUTE'::pg_catalog.text AS privilege_type
  FROM discovery_functions AS discovery
  UNION ALL
  SELECT discovery.expiry_oid AS function_oid,
         'EXECUTE'::pg_catalog.text AS privilege_type
  FROM discovery_functions AS discovery
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
  WHERE database.datname = pg_catalog.current_database()
    AND privilege.grantee = runtime.oid
),
expected_owner_column_acl AS (
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
effective_owner_column_acl AS (
  SELECT owner.rolname AS owner_name,
         relation.relname AS relation_name,
         attribute.attname AS column_name,
         candidate.privilege_type
  FROM discovery_owners AS owner
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
    AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND pg_catalog.has_column_privilege(
      owner.oid,
      relation.oid,
      attribute.attnum,
      candidate.privilege_type
    )
),
direct_owner_schema_acl AS (
  SELECT owner.rolname AS owner_name,
         namespace.nspname AS schema_name,
         privilege.privilege_type,
         privilege.is_grantable
  FROM discovery_owners AS owner
  CROSS JOIN pg_catalog.pg_namespace AS namespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
  WHERE privilege.grantee = owner.oid
)
SELECT
  COALESCE((
    SELECT pg_catalog.count(*) = 3
       AND pg_catalog.bool_and(
         NOT role.rolcanlogin
         AND NOT role.rolinherit
         AND NOT role.rolsuper
         AND NOT role.rolbypassrls
         AND NOT role.rolcreatedb
         AND NOT role.rolcreaterole
         AND NOT role.rolreplication
       )
    FROM fixed_roles AS role
  ), FALSE) AS fixed_role_attributes_safe,
  (
    SELECT pg_catalog.count(*) = 2
    FROM discovery_owners
  )
  AND NOT EXISTS (
    SELECT 1
    FROM discovery_owners AS owner
    WHERE 1 <> (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_auth_members AS edge
      WHERE edge.roleid = owner.oid
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN discovery_owners AS owner ON owner.oid = edge.roleid
    JOIN pg_catalog.pg_roles AS creator ON creator.oid = edge.member
    WHERE NOT edge.admin_option
       OR edge.inherit_option
       OR edge.set_option
       OR NOT creator.rolcreaterole
       OR creator.rolsuper
       OR creator.rolbypassrls
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN discovery_owners AS owner ON owner.oid = edge.member
  ) AS discovery_owner_memberships_safe,
  (
    SELECT pg_catalog.count(*) = 1
    FROM runtime_role
  )
  AND NOT EXISTS (
    SELECT 'public'::pg_catalog.name,
           expected.relation_name,
           expected.privilege_type
    FROM expected_runtime_relation_acl AS expected
    EXCEPT
    SELECT actual.schema_name,
           actual.relation_name,
           actual.privilege_type
    FROM runtime_relation_acl AS actual
  )
  AND NOT EXISTS (
    SELECT actual.schema_name,
           actual.relation_name,
           actual.privilege_type
    FROM runtime_relation_acl AS actual
    EXCEPT
    SELECT 'public'::pg_catalog.name,
           expected.relation_name,
           expected.privilege_type
    FROM expected_runtime_relation_acl AS expected
  )
  AND NOT EXISTS (SELECT 1 FROM runtime_relation_acl WHERE is_grantable)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN runtime_role AS runtime
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = runtime.oid
  )
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
  AND NOT EXISTS (SELECT 1 FROM runtime_sequence_acl WHERE is_grantable)
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
  AND NOT EXISTS (SELECT 1 FROM runtime_function_acl WHERE is_grantable)
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
  AND NOT EXISTS (SELECT 1 FROM runtime_schema_acl WHERE is_grantable)
  AND NOT EXISTS (
    SELECT pg_catalog.current_database()::pg_catalog.name, 'CONNECT'::pg_catalog.text
    EXCEPT
    SELECT actual.database_name, actual.privilege_type
    FROM runtime_database_acl AS actual
  )
  AND NOT EXISTS (
    SELECT actual.database_name, actual.privilege_type
    FROM runtime_database_acl AS actual
    EXCEPT
    SELECT pg_catalog.current_database()::pg_catalog.name, 'CONNECT'::pg_catalog.text
  )
  AND NOT EXISTS (SELECT 1 FROM runtime_database_acl WHERE is_grantable)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN runtime_role AS runtime ON runtime.oid = edge.member
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN runtime_role AS runtime ON runtime.oid = relation.relowner
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN runtime_role AS runtime ON runtime.oid = procedure.proowner
  ) AS runtime_acl_safe,
  (
    SELECT pg_catalog.count(*) = 2
    FROM discovery_owners
  )
  AND NOT EXISTS (
    SELECT expected.owner_name,
           expected.relation_name,
           expected.column_name,
           expected.privilege_type
    FROM expected_owner_column_acl AS expected
    EXCEPT
    SELECT actual.owner_name,
           actual.relation_name,
           actual.column_name,
           actual.privilege_type
    FROM effective_owner_column_acl AS actual
  )
  AND NOT EXISTS (
    SELECT actual.owner_name,
           actual.relation_name,
           actual.column_name,
           actual.privilege_type
    FROM effective_owner_column_acl AS actual
    EXCEPT
    SELECT expected.owner_name,
           expected.relation_name,
           expected.column_name,
           expected.privilege_type
    FROM expected_owner_column_acl AS expected
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN discovery_owners AS owner
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = owner.oid
      AND privilege.is_grantable
  )
  AND NOT EXISTS (
    SELECT 1
    FROM discovery_owners AS owner
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
    FROM discovery_owners AS owner
    CROSS JOIN pg_catalog.pg_class AS sequence
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = sequence.relnamespace
    CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
      AS candidate(privilege_type)
    WHERE namespace.nspname = 'public'
      AND sequence.relkind = 'S'
      AND pg_catalog.has_sequence_privilege(
        owner.oid,
        sequence.oid,
        candidate.privilege_type
      )
  )
  AND NOT EXISTS (
    SELECT owner.rolname, 'public'::pg_catalog.name, 'USAGE'::pg_catalog.text
    FROM discovery_owners AS owner
    EXCEPT
    SELECT actual.owner_name, actual.schema_name, actual.privilege_type
    FROM direct_owner_schema_acl AS actual
  )
  AND NOT EXISTS (
    SELECT actual.owner_name, actual.schema_name, actual.privilege_type
    FROM direct_owner_schema_acl AS actual
    EXCEPT
    SELECT owner.rolname, 'public'::pg_catalog.name, 'USAGE'::pg_catalog.text
    FROM discovery_owners AS owner
  )
  AND NOT EXISTS (SELECT 1 FROM direct_owner_schema_acl WHERE is_grantable)
  AND NOT EXISTS (
    SELECT 1
    FROM discovery_owners AS owner
    WHERE NOT pg_catalog.has_schema_privilege(owner.oid, 'public', 'USAGE')
       OR pg_catalog.has_schema_privilege(owner.oid, 'public', 'CREATE')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN discovery_owners AS owner ON owner.oid = relation.relowner
  )
  AND NOT EXISTS (
    SELECT 1
    FROM discovery_owners AS owner
    WHERE 1 <> (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.proowner = owner.oid
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN discovery_owners AS owner ON owner.oid = procedure.proowner
    CROSS JOIN discovery_functions AS discovery
    WHERE (owner.rolname = 'pylva_budget_projection_discovery_owner'
           AND procedure.oid <> discovery.projection_oid)
       OR (owner.rolname = 'pylva_budget_expiry_discovery_owner'
           AND procedure.oid <> discovery.expiry_oid)
  ) AS discovery_owner_acl_safe,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND privilege.grantee = 0
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND privilege.grantee = 0
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    WHERE namespace.nspname = 'public'
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'CREATE'
  ) AS public_acl_safe`;

// The application login is deployment-defined, so discover the optional login
// from the fixed owner's one non-migrator membership edge. Every login check is
// conditional on that edge; the owner and two migrator edges are mandatory.
const GENERAL_APP_RUNTIME_SECURITY_QUERY = `/* ledger-contract:general-app-runtime-security */
WITH
owner_role AS (
  SELECT role.oid,
         role.rolname,
         role.rolcanlogin,
         role.rolinherit,
         role.rolsuper,
         role.rolbypassrls,
         role.rolcreatedb,
         role.rolcreaterole,
         role.rolreplication
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = 'pylva_general_app_runtime'
),
migration_role AS (
  SELECT role.oid,
         role.rolname,
         role.rolcanlogin,
         role.rolinherit,
         role.rolsuper,
         role.rolbypassrls,
         role.rolcreatedb,
         role.rolcreaterole,
         role.rolreplication
  FROM pg_catalog.pg_roles AS role
  WHERE role.rolname = CURRENT_USER
),
owner_edges AS (
  SELECT edge.roleid,
         edge.member,
         edge.grantor,
         edge.admin_option,
         edge.inherit_option,
         edge.set_option,
         member.rolname AS member_name,
         member.rolcanlogin AS member_can_login,
         member.rolinherit AS member_inherits,
         member.rolsuper AS member_superuser,
         member.rolbypassrls AS member_bypasses_rls,
         member.rolcreatedb AS member_creates_db,
         member.rolcreaterole AS member_creates_role,
         member.rolreplication AS member_replication
  FROM pg_catalog.pg_auth_members AS edge
  JOIN owner_role AS owner ON owner.oid = edge.roleid
  JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
),
app_roles AS (
  SELECT DISTINCT member.oid,
         member.rolname,
         member.rolcanlogin,
         member.rolinherit,
         member.rolsuper,
         member.rolbypassrls,
         member.rolcreatedb,
         member.rolcreaterole,
         member.rolreplication
  FROM owner_edges AS edge
  JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
  WHERE edge.member_name <> CURRENT_USER
),
boundary_roles AS (
  SELECT owner.oid, owner.rolname
  FROM owner_role AS owner
  UNION ALL
  SELECT app.oid, app.rolname
  FROM app_roles AS app
),
expected_legacy_relations(schema_name, relation_name, relation_kind) AS (
  VALUES
    ('public'::pg_catalog.name, 'alert_history'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'anomaly_events'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'api_key_vault'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'api_key_vault_id_seq'::pg_catalog.name, 'S'::"char"),
    ('public'::pg_catalog.name, 'api_keys'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'audit_log'::pg_catalog.name, 'p'::"char"),
    ('public'::pg_catalog.name, 'audit_log_id_seq'::pg_catalog.name, 'S'::"char"),
    ('public'::pg_catalog.name, 'builder_alert_config'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'builder_feature_flags'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'builders'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'cost_sources'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'custom_pricing'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'custom_rule_requests'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'customer_pricing'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'customers'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'feature_flag_overrides'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'invites'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'invoice_idempotency'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'invoices'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'llm_pricing'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'llm_pricing_id_seq'::pg_catalog.name, 'S'::"char"),
    ('public'::pg_catalog.name, 'portal_access_grants'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'portal_configs'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'portal_domains'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'portal_links'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'portal_sessions'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'pricing_onboarding_tasks'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'pricing_sync_log'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'rule_alert_channels'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'rule_events'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'rules'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'stripe_connect'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'stripe_connect_event_log'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'user_builder_memberships'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'users'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'webhook_configs'::pg_catalog.name, 'r'::"char"),
    ('public'::pg_catalog.name, 'webhook_configs_with_grace'::pg_catalog.name, 'v'::"char"),
    ('public'::pg_catalog.name, 'webhook_dlq'::pg_catalog.name, 'r'::"char")
),
audit_partitions AS (
  SELECT child_namespace.nspname AS schema_name,
         child.relname AS relation_name,
         child.relkind AS relation_kind,
         child.relowner
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
expected_owned_relations AS (
  SELECT schema_name, relation_name, relation_kind
  FROM expected_legacy_relations
  UNION ALL
  SELECT schema_name, relation_name, relation_kind
  FROM audit_partitions
),
actual_owned_relations AS (
  SELECT namespace.nspname AS schema_name,
         relation.relname AS relation_name,
         relation.relkind AS relation_kind
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  JOIN owner_role AS owner ON owner.oid = relation.relowner
  WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
),
expected_owned_functions AS (
  SELECT pg_catalog.to_regprocedure('public.generate_slug(text)')::pg_catalog.oid
    AS function_oid
  UNION ALL
  SELECT pg_catalog.to_regprocedure(
    'public.pylva_ensure_audit_log_partition(date)'
  )::pg_catalog.oid AS function_oid
),
actual_owned_functions AS (
  SELECT procedure.oid AS function_oid
  FROM pg_catalog.pg_proc AS procedure
  JOIN owner_role AS owner ON owner.oid = procedure.proowner
),
authority_tables AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind IN ('r', 'p')
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
),
authority_sequence AS (
  SELECT relation.oid
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public'
    AND relation.relkind = 'S'
    AND relation.relname = 'pylva_budget_authority_order_seq'
),
discovery_functions AS (
  SELECT pg_catalog.to_regprocedure(
    'public.pylva_budget_projection_actionable_builders(uuid,integer)'
  )::pg_catalog.oid AS function_oid
  UNION ALL
  SELECT pg_catalog.to_regprocedure(
    'public.pylva_budget_expiry_actionable_builders(uuid,integer)'
  )::pg_catalog.oid AS function_oid
),
partition_function AS (
  SELECT procedure.*
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = pg_catalog.to_regprocedure(
    'public.pylva_ensure_audit_log_partition(date)'
  )
)
SELECT
  COALESCE((
    SELECT pg_catalog.count(*) = 1
       AND pg_catalog.bool_and(
         NOT owner.rolcanlogin
         AND NOT owner.rolinherit
         AND NOT owner.rolsuper
         AND NOT owner.rolbypassrls
         AND NOT owner.rolcreatedb
         AND NOT owner.rolcreaterole
         AND NOT owner.rolreplication
       )
    FROM owner_role AS owner
  ), FALSE) AS general_app_fixed_role_attributes_safe,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    JOIN owner_role AS owner ON owner.oid = database.datdba
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    JOIN owner_role AS owner ON owner.oid = namespace.nspowner
  )
  AND NOT EXISTS (
    SELECT expected.schema_name, expected.relation_name, expected.relation_kind
    FROM expected_owned_relations AS expected
    EXCEPT
    SELECT actual.schema_name, actual.relation_name, actual.relation_kind
    FROM actual_owned_relations AS actual
  )
  AND NOT EXISTS (
    SELECT actual.schema_name, actual.relation_name, actual.relation_kind
    FROM actual_owned_relations AS actual
    EXCEPT
    SELECT expected.schema_name, expected.relation_name, expected.relation_kind
    FROM expected_owned_relations AS expected
  )
  AND NOT EXISTS (
    SELECT 1
    FROM audit_partitions AS partition
    JOIN owner_role AS owner ON TRUE
    WHERE partition.relation_kind <> 'r'
       OR partition.relation_name !~ '^audit_log_y[0-9]{4}m(0[1-9]|1[0-2])$'
       OR partition.relowner <> owner.oid
  )
  AND NOT EXISTS (
    SELECT expected.function_oid
    FROM expected_owned_functions AS expected
    EXCEPT
    SELECT actual.function_oid
    FROM actual_owned_functions AS actual
  )
  AND NOT EXISTS (
    SELECT actual.function_oid
    FROM actual_owned_functions AS actual
    EXCEPT
    SELECT expected.function_oid
    FROM expected_owned_functions AS expected
  ) AS general_app_ownership_safe,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS default_acl
    JOIN boundary_roles AS boundary ON boundary.oid = default_acl.defaclrole
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl AS default_acl
    CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) AS privilege
    JOIN boundary_roles AS boundary ON boundary.oid = privilege.grantee
  ) AS general_app_default_acl_safe,
  COALESCE((
    SELECT pg_catalog.count(*) = 1
       AND pg_catalog.bool_and(
         migration.rolcanlogin
         AND migration.rolinherit
         AND NOT migration.rolsuper
         AND NOT migration.rolbypassrls
         AND migration.rolcreaterole
         AND NOT migration.rolreplication
       )
    FROM migration_role AS migration
  ), FALSE)
  AND (SELECT pg_catalog.count(*) IN (2, 3) FROM owner_edges)
  AND (
    SELECT pg_catalog.count(*) = 2
    FROM owner_edges AS edge
    WHERE edge.member_name = CURRENT_USER
  )
  AND (
    SELECT pg_catalog.count(*) = 1
    FROM owner_edges AS edge
    WHERE edge.member_name = CURRENT_USER
      AND edge.admin_option
      AND NOT edge.inherit_option
      AND NOT edge.set_option
  )
  AND (
    SELECT pg_catalog.count(*) = 1
    FROM owner_edges AS edge
    WHERE edge.member_name = CURRENT_USER
      AND NOT edge.admin_option
      AND NOT edge.inherit_option
      AND edge.set_option
  )
  AND NOT EXISTS (
    SELECT 1
    FROM owner_edges AS edge
    WHERE edge.member_name = CURRENT_USER
      AND (
        NOT edge.member_can_login
        OR NOT edge.member_inherits
        OR edge.member_superuser
        OR edge.member_bypasses_rls
        OR NOT edge.member_creates_role
        OR edge.member_replication
      )
  )
  AND (SELECT pg_catalog.count(*) <= 1 FROM app_roles)
  AND (
    SELECT pg_catalog.count(*) <= 1
    FROM owner_edges AS edge
    WHERE edge.member_name <> CURRENT_USER
  )
  AND NOT EXISTS (
    SELECT 1
    FROM owner_edges AS edge
    WHERE edge.member_name <> CURRENT_USER
      AND (
        NOT edge.member_can_login
        OR NOT edge.member_inherits
        OR edge.member_superuser
        OR edge.member_bypasses_rls
        OR edge.member_creates_db
        OR edge.member_creates_role
        OR edge.member_replication
        OR edge.admin_option
        OR NOT edge.inherit_option
        OR edge.set_option
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS edge
    JOIN owner_role AS owner ON owner.oid = edge.member
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app_roles AS app
    WHERE 1 <> (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_auth_members AS edge
      WHERE edge.member = app.oid
    )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS edge
         JOIN owner_role AS owner ON TRUE
         WHERE edge.member = app.oid
           AND (
             edge.roleid <> owner.oid
             OR edge.admin_option
             OR NOT edge.inherit_option
             OR edge.set_option
           )
       )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM app_roles AS app
    WHERE (
      SELECT pg_catalog.count(*) > 1
      FROM pg_catalog.pg_auth_members AS edge
      WHERE edge.roleid = app.oid
    )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_auth_members AS edge
         JOIN pg_catalog.pg_roles AS member ON member.oid = edge.member
         WHERE edge.roleid = app.oid
           AND (
             member.rolname <> CURRENT_USER
             OR NOT member.rolcanlogin
             OR NOT member.rolinherit
             OR member.rolsuper
             OR member.rolbypassrls
             OR NOT member.rolcreaterole
             OR member.rolreplication
             OR NOT edge.admin_option
             OR edge.inherit_option
             OR edge.set_option
           )
       )
  ) AS general_app_memberships_safe,
  (SELECT pg_catalog.count(*) <= 1 FROM app_roles)
  AND NOT EXISTS (
    SELECT 1
    FROM app_roles AS app
    WHERE NOT app.rolcanlogin
       OR NOT app.rolinherit
       OR app.rolsuper
       OR app.rolbypassrls
       OR app.rolcreatedb
       OR app.rolcreaterole
       OR app.rolreplication
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    JOIN app_roles AS app ON app.oid = database.datdba
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    JOIN app_roles AS app ON app.oid = namespace.nspowner
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN app_roles AS app ON app.oid = relation.relowner
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN app_roles AS app ON app.oid = procedure.proowner
  ) AS general_app_login_attributes_and_ownership_safe,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database AS database
    CROSS JOIN LATERAL pg_catalog.aclexplode(database.datacl) AS privilege
    JOIN app_roles AS app ON app.oid = privilege.grantee
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace AS namespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
    JOIN app_roles AS app ON app.oid = privilege.grantee
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS privilege
    JOIN app_roles AS app ON app.oid = privilege.grantee
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS privilege
    JOIN app_roles AS app ON app.oid = privilege.grantee
  ) AS general_app_login_direct_acl_safe,
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    JOIN app_roles AS app ON app.oid = privilege.grantee
    WHERE attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) AS general_app_login_column_acl_safe,
  (SELECT pg_catalog.count(*) = 1 FROM owner_role)
  AND (SELECT pg_catalog.count(*) = 10 FROM authority_tables)
  AND (SELECT pg_catalog.count(*) = 1 FROM authority_sequence)
  AND (SELECT pg_catalog.count(*) = 2 FROM discovery_functions WHERE function_oid IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    CROSS JOIN authority_tables AS relation
    CROSS JOIN LATERAL (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
      ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
    ) AS candidate(privilege_type)
    WHERE pg_catalog.has_table_privilege(
      boundary.oid,
      relation.oid,
      candidate.privilege_type
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    CROSS JOIN authority_tables AS relation
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    CROSS JOIN LATERAL (VALUES
      ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')
    ) AS candidate(privilege_type)
    WHERE pg_catalog.has_column_privilege(
      boundary.oid,
      relation.oid,
      attribute.attnum,
      candidate.privilege_type
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    CROSS JOIN authority_sequence AS sequence
    CROSS JOIN LATERAL (VALUES ('USAGE'), ('SELECT'), ('UPDATE'))
      AS candidate(privilege_type)
    WHERE pg_catalog.has_sequence_privilege(
      boundary.oid,
      sequence.oid,
      candidate.privilege_type
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    CROSS JOIN discovery_functions AS function
    WHERE pg_catalog.has_function_privilege(
      boundary.oid,
      function.function_oid,
      'EXECUTE'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    CROSS JOIN LATERAL (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'))
      AS candidate(privilege_type)
    WHERE NOT pg_catalog.has_table_privilege(
      boundary.oid,
      'public.builders',
      candidate.privilege_type
    )
       OR NOT pg_catalog.has_table_privilege(
         boundary.oid,
         'public.user_builder_memberships',
         candidate.privilege_type
       )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    WHERE NOT pg_catalog.has_table_privilege(
      boundary.oid,
      'public.schema_migrations',
      'SELECT'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    CROSS JOIN LATERAL (VALUES
      ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
    ) AS candidate(privilege_type)
    WHERE pg_catalog.has_table_privilege(
      boundary.oid,
      'public.schema_migrations',
      candidate.privilege_type
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass('public.schema_migrations')
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    CROSS JOIN LATERAL (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES'))
      AS candidate(privilege_type)
    WHERE pg_catalog.has_column_privilege(
      boundary.oid,
      attribute.attrelid,
      attribute.attnum,
      candidate.privilege_type
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM boundary_roles AS boundary
    WHERE NOT pg_catalog.has_schema_privilege(boundary.oid, 'public', 'USAGE')
       OR NOT pg_catalog.has_schema_privilege(boundary.oid, 'public', 'CREATE')
       OR NOT pg_catalog.has_database_privilege(
         boundary.oid,
         pg_catalog.current_database(),
         'CONNECT'
       )
  ) AS general_app_effective_acl_safe,
  COALESCE((
    SELECT pg_catalog.count(*) = 1
       AND pg_catalog.bool_and(
         procedure.proowner = owner.oid
         AND procedure.prosecdef
         AND procedure.provolatile = 'v'
         AND procedure.prokind = 'f'
         AND NOT procedure.proretset
         AND procedure.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
         AND language.lanname = 'plpgsql'
         AND pg_catalog.cardinality(procedure.proconfig) = 2
         AND procedure.proconfig @> ARRAY['search_path=pg_catalog']::pg_catalog.text[]
         AND (
           SELECT pg_catalog.count(*) = 1
           FROM pg_catalog.unnest(procedure.proconfig) AS setting(value)
           WHERE setting.value LIKE 'TimeZone=%'
             AND pg_catalog.length(
               pg_catalog.split_part(setting.value, '=', 2)
             ) > 0
         )
         AND (
           SELECT pg_catalog.count(*) = 1
              AND pg_catalog.bool_and(
                privilege.grantee = procedure.proowner
                AND privilege.privilege_type = 'EXECUTE'
                AND NOT privilege.is_grantable
              )
           FROM pg_catalog.aclexplode(
             COALESCE(
               procedure.proacl,
               pg_catalog.acldefault('f', procedure.proowner)
             )
           ) AS privilege
         )
       )
    FROM partition_function AS procedure
    JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
    JOIN owner_role AS owner ON TRUE
  ), FALSE) AS general_app_partition_function_safe`;

const BUDGET_NUMERIC_COLUMNS_QUERY = `/* ledger-contract:numeric-columns */
SELECT table_name,
       column_name,
       numeric_precision::text AS numeric_precision,
       numeric_scale::text AS numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = ANY($1::text[])
  AND data_type = 'numeric'
ORDER BY table_name, ordinal_position`;

const BUDGET_SEQUENCES_QUERY = `/* ledger-contract:sequences */
SELECT sequence_class.relname AS sequence_name,
       pg_catalog.format_type(sequence_catalog.seqtypid, NULL) AS data_type,
       sequence_catalog.seqstart::text AS start_value,
       sequence_catalog.seqmin::text AS min_value,
       sequence_catalog.seqmax::text AS max_value,
       sequence_catalog.seqincrement::text AS increment_by,
       sequence_catalog.seqcycle AS cycle,
       sequence_catalog.seqcache::text AS cache_size,
       pg_catalog.pg_get_userbyid(sequence_class.relowner) AS owner_name,
       NOT EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(sequence_class.relacl) acl
         WHERE acl.grantee = 0
       ) AS public_has_no_privileges,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_depend dependency
         WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
           AND dependency.objid = sequence_class.oid
           AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
           AND dependency.deptype IN ('a', 'i')
       ) AS owned_by_column
FROM pg_catalog.pg_class sequence_class
JOIN pg_catalog.pg_namespace sequence_namespace
  ON sequence_namespace.oid = sequence_class.relnamespace
JOIN pg_catalog.pg_sequence sequence_catalog
  ON sequence_catalog.seqrelid = sequence_class.oid
WHERE sequence_namespace.nspname = 'public'
  AND sequence_class.relkind = 'S'
  AND sequence_class.relname LIKE 'pylva_budget\\_%' ESCAPE '\\'
ORDER BY sequence_class.relname`;

const BUDGET_RLS_QUERY = `/* ledger-contract:rls */
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = ANY($1::text[])
ORDER BY c.relname`;

const BUDGET_POLICIES_QUERY = `/* ledger-contract:policies */
SELECT tablename AS table_name,
       policyname AS policy_name,
       cmd AS command,
       (permissive = 'PERMISSIVE') AS permissive,
       array_to_string(roles, ',') AS roles,
       qual AS using_expression,
       with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = ANY($1::text[])
ORDER BY tablename, policyname`;

const BUDGET_TENANT_FOREIGN_KEYS_QUERY = `/* ledger-contract:tenant-foreign-keys */
SELECT child.relname AS child_table,
       con.conname AS constraint_name,
       parent.relname AS parent_table,
       con.convalidated AS validated,
       con.condeferrable AS deferrable,
       con.condeferred AS initially_deferred,
       CASE con.confdeltype
         WHEN 'a' THEN 'NO ACTION'
         WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE'
         WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT'
       END AS delete_action,
       CASE con.confupdtype
         WHEN 'a' THEN 'NO ACTION'
         WHEN 'r' THEN 'RESTRICT'
         WHEN 'c' THEN 'CASCADE'
         WHEN 'n' THEN 'SET NULL'
         WHEN 'd' THEN 'SET DEFAULT'
       END AS update_action,
       CASE con.confmatchtype
         WHEN 's' THEN 'SIMPLE'
         WHEN 'f' THEN 'FULL'
         WHEN 'p' THEN 'PARTIAL'
       END AS match_type,
       string_agg(child_attribute.attname, ',' ORDER BY key_position.ordinality) AS child_columns,
       string_agg(parent_attribute.attname, ',' ORDER BY key_position.ordinality) AS parent_columns
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_class parent ON parent.oid = con.confrelid
JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY
  AS key_position(child_attnum, parent_attnum, ordinality) ON true
JOIN pg_attribute child_attribute
  ON child_attribute.attrelid = child.oid
 AND child_attribute.attnum = key_position.child_attnum
JOIN pg_attribute parent_attribute
  ON parent_attribute.attrelid = parent.oid
 AND parent_attribute.attnum = key_position.parent_attnum
WHERE con.contype = 'f'
  AND child_namespace.nspname = 'public'
  AND child.relname = ANY($1::text[])
GROUP BY child.relname,
         con.conname,
         parent.relname,
         con.convalidated,
         con.condeferrable,
         con.condeferred,
         con.confdeltype,
         con.confupdtype,
         con.confmatchtype
ORDER BY child.relname, con.conname`;

const BUDGET_INDEXES_QUERY = `/* ledger-contract:indexes */
SELECT table_class.relname AS table_name,
       index_class.relname AS index_name,
       access_method.amname AS access_method,
       index_catalog.indisunique AS unique,
       index_catalog.indisvalid AS valid,
       index_catalog.indisready AS ready,
       index_catalog.indnullsnotdistinct AS nulls_not_distinct,
       string_agg(attribute.attname, ',' ORDER BY key_position.ordinality)
         FILTER (WHERE key_position.ordinality <= index_catalog.indnkeyatts) AS key_columns,
       COALESCE(
         string_agg(attribute.attname, ',' ORDER BY key_position.ordinality)
           FILTER (WHERE key_position.ordinality > index_catalog.indnkeyatts),
         ''
       ) AS included_columns,
       COALESCE(
         string_agg(attribute.attname, ',' ORDER BY key_position.ordinality)
           FILTER (
             WHERE key_position.ordinality <= index_catalog.indnkeyatts
               AND (
                 index_catalog.indoption[(key_position.ordinality - 1)::integer] & 1
               ) = 1
           ),
         ''
       ) AS descending_columns,
       COALESCE(
         string_agg(attribute.attname, ',' ORDER BY key_position.ordinality)
           FILTER (
             WHERE key_position.ordinality <= index_catalog.indnkeyatts
               AND (
                 index_catalog.indoption[(key_position.ordinality - 1)::integer] & 2
               ) = 2
           ),
         ''
       ) AS nulls_first_columns,
       pg_get_expr(index_catalog.indpred, index_catalog.indrelid) AS predicate,
       pg_get_indexdef(index_catalog.indexrelid) AS definition
FROM pg_index index_catalog
JOIN pg_class table_class ON table_class.oid = index_catalog.indrelid
JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
JOIN pg_class index_class ON index_class.oid = index_catalog.indexrelid
JOIN pg_am access_method ON access_method.oid = index_class.relam
JOIN LATERAL unnest(index_catalog.indkey) WITH ORDINALITY
  AS key_position(attnum, ordinality) ON key_position.attnum > 0
JOIN pg_attribute attribute
  ON attribute.attrelid = table_class.oid
 AND attribute.attnum = key_position.attnum
LEFT JOIN pg_constraint backing_constraint
  ON backing_constraint.conindid = index_catalog.indexrelid
WHERE table_namespace.nspname = 'public'
  AND table_class.relname = ANY($1::text[])
  AND (
    backing_constraint.oid IS NULL
    OR index_catalog.indnullsnotdistinct
  )
GROUP BY table_class.relname,
         index_class.relname,
         access_method.amname,
         index_catalog.indisunique,
         index_catalog.indisvalid,
         index_catalog.indisready,
         index_catalog.indnullsnotdistinct,
         index_catalog.indnkeyatts,
         index_catalog.indpred,
         index_catalog.indrelid,
         index_catalog.indexrelid
ORDER BY table_class.relname, index_class.relname`;

const BUDGET_IMMUTABILITY_TRIGGERS_QUERY = `/* ledger-contract:immutability-triggers */
SELECT table_class.relname AS table_name,
       trigger_catalog.tgname AS trigger_name,
       function_catalog.proname AS function_name,
       function_namespace.nspname AS function_schema,
       (trigger_catalog.tgenabled = 'O') AS enabled,
       (trigger_catalog.tgconstraint <> 0) AS constraint_trigger,
       COALESCE(trigger_constraint.condeferrable, false) AS deferrable,
       COALESCE(trigger_constraint.condeferred, false) AS initially_deferred,
       ((trigger_catalog.tgtype & 1) <> 0) AS row_level,
       ((trigger_catalog.tgtype & 2) <> 0) AS before,
       ((trigger_catalog.tgtype & 4) <> 0) AS insert_event,
       ((trigger_catalog.tgtype & 8) <> 0) AS delete_event,
       ((trigger_catalog.tgtype & 16) <> 0) AS update_event,
       ((trigger_catalog.tgtype & 32) <> 0) AS truncate_event,
       pg_get_triggerdef(trigger_catalog.oid) AS definition
FROM pg_trigger trigger_catalog
JOIN pg_class table_class ON table_class.oid = trigger_catalog.tgrelid
JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
JOIN pg_proc function_catalog ON function_catalog.oid = trigger_catalog.tgfoid
JOIN pg_namespace function_namespace ON function_namespace.oid = function_catalog.pronamespace
LEFT JOIN pg_constraint trigger_constraint
  ON trigger_constraint.oid = trigger_catalog.tgconstraint
WHERE table_namespace.nspname = 'public'
  AND table_class.relname = ANY($1::text[])
  AND NOT trigger_catalog.tgisinternal
ORDER BY table_class.relname, trigger_catalog.tgname`;

function equalStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function readBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${key} to be a boolean`);
  }
  return value;
}

function readNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected ${key} to be a string or null`);
  }
  return value;
}

function readInteger(row: Record<string, unknown>, key: string): number {
  const value = readString(row, key);
  if (!/^\d+$/.test(value)) {
    throw new Error(`Expected ${key} to be a nonnegative integer string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Expected ${key} to be a safe integer string`);
  }
  return parsed;
}

function readNullableInteger(row: Record<string, unknown>, key: string): number | null {
  return row[key] === null ? null : readInteger(row, key);
}

function readColumnList(row: Record<string, unknown>, key: string): string[] {
  const value = readString(row, key);
  return value === '' ? [] : value.split(',');
}

function classifyColumnDefault(expression: string | null): string {
  if (expression === null) return 'none';
  const normalized = expression.toLowerCase().replaceAll('public.', '').replace(/\s+/g, '');
  if (normalized === 'gen_random_uuid()') return 'uuid';
  if (normalized === 'now()') return 'now';
  if (normalized === 'statement_timestamp()') return 'statement_timestamp';
  if (/^0(?:::[a-z0-9_ ]+)?$/.test(normalized)) return 'zero';
  if (normalized === 'false') return 'false';
  if (normalized === "'{}'::jsonb") return 'empty_object';
  if (normalized === 'array[]::uuid[]') return 'empty_uuid_array';
  if (normalized === "repeat('0'::text,64)") return 'zero_hash';
  const textDefault = normalized.match(/^'(none|pending|unknown)'::charactervarying$/);
  if (textDefault !== null) return `text:${textDefault[1]}`;
  return `other:${normalized}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function comparePhysicalIdentities<T>({
  actual,
  expected,
  identity,
  invalid = [],
}: {
  actual: T[];
  expected: readonly string[];
  identity: (item: T) => string;
  invalid?: string[];
}): PhysicalObjectCheck<T> {
  const actualIdentities = sortedUnique(actual.map(identity));
  const expectedIdentities = sortedUnique(expected);
  const actualSet = new Set(actualIdentities);
  const expectedSet = new Set(expectedIdentities);

  return {
    actual,
    invalid: sortedUnique(invalid),
    missing: expectedIdentities.filter((item) => !actualSet.has(item)),
    unexpected: actualIdentities.filter((item) => !expectedSet.has(item)),
  };
}

function physicalCheckOk(
  check: Pick<PhysicalObjectCheck<unknown>, 'invalid' | 'missing' | 'unexpected'>,
): boolean {
  return check.invalid.length === 0 && check.missing.length === 0 && check.unexpected.length === 0;
}

function ledgerObjectIdentity(tableName: string, objectName: string): string {
  return `${tableName}.${objectName}`;
}

function ledgerColumnIdentity(column: PhysicalLedgerColumn | ExpectedLedgerColumn): string {
  return ledgerObjectIdentity(column.table_name, column.column_name);
}

function ledgerCheckIdentity(check: PhysicalLedgerCheck | ExpectedLedgerCheck): string {
  return ledgerObjectIdentity(check.table_name, check.constraint_name);
}

function ledgerKeyIdentity(key: PhysicalLedgerKey | ExpectedLedgerKey): string {
  return ledgerObjectIdentity(key.table_name, key.constraint_name);
}

function ledgerFunctionIdentity(helper: PhysicalLedgerFunction | ExpectedLedgerFunction): string {
  return `${helper.function_name}(${helper.identity_arguments})`;
}

function ledgerSequenceIdentity(sequence: PhysicalLedgerSequence | ExpectedLedgerSequence): string {
  return sequence.sequence_name;
}

function asScopeConstraint(row: Record<string, unknown>): PhysicalScopeConstraint {
  return {
    definition: readString(row, 'definition'),
    name: readString(row, 'conname'),
    validated: readBoolean(row, 'convalidated'),
  };
}

function asLedgerRow(row: Record<string, unknown>): { checksum: string; filename: string } {
  return {
    checksum: readString(row, 'checksum'),
    filename: readString(row, 'filename'),
  };
}

function asScopeDistribution(row: Record<string, unknown>): { count: string; scope: string } {
  return {
    count: readString(row, 'count'),
    scope: readString(row, 'scope'),
  };
}

function asNumericColumn(row: Record<string, unknown>): PhysicalNumericColumn {
  return {
    column_name: readString(row, 'column_name'),
    numeric_precision: readNullableInteger(row, 'numeric_precision'),
    numeric_scale: readNullableInteger(row, 'numeric_scale'),
    table_name: readString(row, 'table_name'),
  };
}

function asLedgerSequence(row: Record<string, unknown>): PhysicalLedgerSequence {
  return {
    cache_size: readString(row, 'cache_size'),
    cycle: readBoolean(row, 'cycle'),
    data_type: readString(row, 'data_type'),
    increment_by: readString(row, 'increment_by'),
    max_value: readString(row, 'max_value'),
    min_value: readString(row, 'min_value'),
    owned_by_column: readBoolean(row, 'owned_by_column'),
    owner_name: readString(row, 'owner_name'),
    public_has_no_privileges: readBoolean(row, 'public_has_no_privileges'),
    sequence_name: readString(row, 'sequence_name'),
    start_value: readString(row, 'start_value'),
  };
}

function asLedgerColumn(row: Record<string, unknown>): PhysicalLedgerColumn {
  const defaultExpression = readNullableString(row, 'default_expression');
  return {
    column_name: readString(row, 'column_name'),
    data_type: readString(row, 'data_type'),
    default_expression: defaultExpression,
    default_kind: classifyColumnDefault(defaultExpression),
    nullable: readBoolean(row, 'nullable'),
    table_name: readString(row, 'table_name'),
  };
}

function asLedgerCheck(row: Record<string, unknown>): PhysicalLedgerCheck {
  return {
    constraint_name: readString(row, 'constraint_name'),
    definition_hash: readString(row, 'definition_hash'),
    table_name: readString(row, 'table_name'),
    validated: readBoolean(row, 'validated'),
  };
}

function asLedgerKey(row: Record<string, unknown>): PhysicalLedgerKey {
  return {
    columns: readColumnList(row, 'columns'),
    constraint_name: readString(row, 'constraint_name'),
    constraint_type: readString(row, 'constraint_type'),
    nulls_not_distinct: readBoolean(row, 'nulls_not_distinct'),
    table_name: readString(row, 'table_name'),
    validated: readBoolean(row, 'validated'),
  };
}

function asLedgerFunction(row: Record<string, unknown>): PhysicalLedgerFunction {
  return {
    configuration: readString(row, 'configuration').replace(/\s+/g, ''),
    function_name: readString(row, 'function_name'),
    identity_arguments: readString(row, 'identity_arguments').replaceAll('public.', ''),
    language: readString(row, 'language'),
    parallel_safety: readString(row, 'parallel_safety'),
    result_type: readString(row, 'result_type'),
    security_definer: readBoolean(row, 'security_definer'),
    source_hash: readString(row, 'source_hash'),
    strict: readBoolean(row, 'strict'),
    volatility: readString(row, 'volatility'),
  };
}

function asDiscoveryFunction(row: Record<string, unknown>): PhysicalDiscoveryFunction {
  return {
    ...asLedgerFunction(row),
    acl_grantees: readColumnList(row, 'acl_grantees'),
    acl_is_exact: readBoolean(row, 'acl_is_exact'),
    default_argument_count: readInteger(row, 'default_argument_count'),
    function_kind: readString(row, 'function_kind'),
    leakproof: readBoolean(row, 'leakproof'),
    owner_name: readString(row, 'owner_name'),
    return_type_oid: readString(row, 'return_type_oid'),
    returns_set: readBoolean(row, 'returns_set'),
  };
}

function asRuntimeSecurity(
  row: Record<string, unknown>,
  generalAppRow: Record<string, unknown>,
): PhysicalBudgetRuntimeSecurity {
  return {
    discovery_owner_acl_safe: readBoolean(row, 'discovery_owner_acl_safe'),
    discovery_owner_memberships_safe: readBoolean(row, 'discovery_owner_memberships_safe'),
    fixed_role_attributes_safe: readBoolean(row, 'fixed_role_attributes_safe'),
    general_app_default_acl_safe: readBoolean(generalAppRow, 'general_app_default_acl_safe'),
    general_app_effective_acl_safe: readBoolean(generalAppRow, 'general_app_effective_acl_safe'),
    general_app_fixed_role_attributes_safe: readBoolean(
      generalAppRow,
      'general_app_fixed_role_attributes_safe',
    ),
    general_app_login_attributes_and_ownership_safe: readBoolean(
      generalAppRow,
      'general_app_login_attributes_and_ownership_safe',
    ),
    general_app_login_column_acl_safe: readBoolean(
      generalAppRow,
      'general_app_login_column_acl_safe',
    ),
    general_app_login_direct_acl_safe: readBoolean(
      generalAppRow,
      'general_app_login_direct_acl_safe',
    ),
    general_app_memberships_safe: readBoolean(generalAppRow, 'general_app_memberships_safe'),
    general_app_ownership_safe: readBoolean(generalAppRow, 'general_app_ownership_safe'),
    general_app_partition_function_safe: readBoolean(
      generalAppRow,
      'general_app_partition_function_safe',
    ),
    public_acl_safe: readBoolean(row, 'public_acl_safe'),
    runtime_acl_safe: readBoolean(row, 'runtime_acl_safe'),
  };
}

function asRlsTable(row: Record<string, unknown>): PhysicalRlsTable {
  return {
    rls_enabled: readBoolean(row, 'rls_enabled'),
    rls_forced: readBoolean(row, 'rls_forced'),
    table_name: readString(row, 'table_name'),
  };
}

function asTenantPolicy(row: Record<string, unknown>): PhysicalTenantPolicy {
  return {
    command: readString(row, 'command'),
    permissive: readBoolean(row, 'permissive'),
    policy_name: readString(row, 'policy_name'),
    roles: readColumnList(row, 'roles'),
    table_name: readString(row, 'table_name'),
    using_expression: readNullableString(row, 'using_expression'),
    with_check_expression: readNullableString(row, 'with_check_expression'),
  };
}

function asTenantForeignKey(row: Record<string, unknown>): PhysicalTenantForeignKey {
  return {
    child_columns: readColumnList(row, 'child_columns'),
    child_table: readString(row, 'child_table'),
    constraint_name: readString(row, 'constraint_name'),
    deferrable: readBoolean(row, 'deferrable'),
    delete_action: readString(row, 'delete_action'),
    initially_deferred: readBoolean(row, 'initially_deferred'),
    match_type: readString(row, 'match_type'),
    parent_columns: readColumnList(row, 'parent_columns'),
    parent_table: readString(row, 'parent_table'),
    update_action: readString(row, 'update_action'),
    validated: readBoolean(row, 'validated'),
  };
}

function asLedgerIndex(row: Record<string, unknown>): PhysicalLedgerIndex {
  return {
    access_method: readString(row, 'access_method'),
    definition: readString(row, 'definition'),
    descending_columns: readColumnList(row, 'descending_columns'),
    included_columns: readColumnList(row, 'included_columns'),
    index_name: readString(row, 'index_name'),
    key_columns: readColumnList(row, 'key_columns'),
    nulls_not_distinct: readBoolean(row, 'nulls_not_distinct'),
    nulls_first_columns: readColumnList(row, 'nulls_first_columns'),
    predicate: readNullableString(row, 'predicate'),
    ready: readBoolean(row, 'ready'),
    table_name: readString(row, 'table_name'),
    unique: readBoolean(row, 'unique'),
    valid: readBoolean(row, 'valid'),
  };
}

function asImmutabilityTrigger(row: Record<string, unknown>): PhysicalImmutabilityTrigger {
  return {
    before: readBoolean(row, 'before'),
    constraint_trigger: readBoolean(row, 'constraint_trigger'),
    deferrable: readBoolean(row, 'deferrable'),
    definition: readString(row, 'definition'),
    delete_event: readBoolean(row, 'delete_event'),
    enabled: readBoolean(row, 'enabled'),
    function_name: readString(row, 'function_name'),
    function_schema: readString(row, 'function_schema'),
    initially_deferred: readBoolean(row, 'initially_deferred'),
    insert_event: readBoolean(row, 'insert_event'),
    row_level: readBoolean(row, 'row_level'),
    table_name: readString(row, 'table_name'),
    trigger_name: readString(row, 'trigger_name'),
    truncate_event: readBoolean(row, 'truncate_event'),
    update_event: readBoolean(row, 'update_event'),
  };
}

/** Extract the string literals used by PostgreSQL's rendered CHECK definition. */
export function scopeValuesFromConstraintDefinition(definition: string): string[] {
  const values = new Set<string>();
  for (const match of definition.matchAll(/'((?:[^']|'')*)'/g)) {
    values.add(match[1]!.replaceAll("''", "'"));
  }
  return [...values].sort();
}

function normalizeSqlExpression(expression: string): string {
  const flattened = expression
    .toLowerCase()
    .replace(/::(?:character varying|text)(?:\[\])?/g, '')
    .replace(/[()\s"]/g, '');
  return flattened.replace(/=anyarray\[([^\]]*)\]/g, 'in$1');
}

function normalizePolicyExpression(expression: string): string {
  return expression
    .toLowerCase()
    .replaceAll('pg_catalog.', '')
    .replace(
      /::(?:character varying|text|uuid|regtype|integer|bigint|timestamp with time zone)/g,
      '',
    )
    .replace(/[()\s"]/g, '');
}

function tenantPolicyIdentity(policy: PhysicalTenantPolicy | ExpectedTenantPolicy): string {
  return ledgerObjectIdentity(policy.table_name, policy.policy_name);
}

function policyMatchesExpectation(
  policy: PhysicalTenantPolicy,
  expected: ExpectedTenantPolicy,
): boolean {
  return (
    policy.command === expected.command &&
    policy.permissive === expected.permissive &&
    sameOrderedStrings([...policy.roles].sort(), [...expected.roles].sort()) &&
    normalizePolicyExpression(policy.using_expression ?? '') ===
      normalizePolicyExpression(expected.using_expression) &&
    (policy.with_check_expression === null
      ? expected.with_check_expression === null
      : expected.with_check_expression !== null &&
        normalizePolicyExpression(policy.with_check_expression) ===
          normalizePolicyExpression(expected.with_check_expression))
  );
}

function tenantForeignKeyIdentity(
  foreignKey: PhysicalTenantForeignKey | ExpectedTenantForeignKey,
): string {
  return ledgerObjectIdentity(foreignKey.child_table, foreignKey.constraint_name);
}

function ledgerIndexIdentity(index: PhysicalLedgerIndex | ExpectedLedgerIndex): string {
  return ledgerObjectIdentity(index.table_name, index.index_name);
}

function triggerIdentity(trigger: PhysicalImmutabilityTrigger | ExpectedLedgerTrigger): string {
  return ledgerObjectIdentity(trigger.table_name, trigger.trigger_name);
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function indexMatchesExpectation(
  index: PhysicalLedgerIndex,
  expected: ExpectedLedgerIndex,
): boolean {
  const predicateMatches =
    index.predicate === expected.predicate ||
    (index.predicate !== null &&
      expected.predicate !== null &&
      normalizeSqlExpression(index.predicate) === normalizeSqlExpression(expected.predicate));

  return (
    index.table_name === expected.table_name &&
    index.index_name === expected.index_name &&
    sameOrderedStrings(index.key_columns, expected.key_columns) &&
    sameOrderedStrings(index.descending_columns, expected.descending_columns ?? []) &&
    sameOrderedStrings(index.nulls_first_columns, expected.descending_columns ?? []) &&
    sameOrderedStrings(index.included_columns, expected.included_columns ?? []) &&
    index.unique === expected.unique &&
    index.nulls_not_distinct === expected.nulls_not_distinct &&
    index.access_method === 'btree' &&
    index.valid &&
    index.ready &&
    predicateMatches
  );
}

export function parseVerifyPhysicalSchemaArgs(argv: string[]): VerifyPhysicalSchemaArgs {
  let contract: PhysicalSchemaContract | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // pnpm preserves its conventional argument separator when this script is
    // run as `pnpm db:migrate:verify-physical -- --contract …`.
    if (arg === '--') {
      continue;
    }
    if (arg === '--contract') {
      const value = argv[index + 1];
      if (!PHYSICAL_SCHEMA_CONTRACTS.includes(value as PhysicalSchemaContract)) {
        throw new Error(`--contract must be one of: ${PHYSICAL_SCHEMA_CONTRACTS.join(', ')}`);
      }
      contract = value as PhysicalSchemaContract;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg ?? ''}`);
  }

  if (contract === undefined) {
    throw new Error(`--contract is required (${PHYSICAL_SCHEMA_CONTRACTS.join(' or ')})`);
  }

  return { contract, json };
}

export async function verifyApiKeyScopeContract({
  migrations,
  sql,
}: {
  migrations: MigrationFile[];
  sql: PhysicalSchemaSqlClient;
}): Promise<PhysicalSchemaContractResult> {
  const expectedChecksums = new Map(
    migrations
      .filter((migration) =>
        API_KEY_SCOPE_MIGRATIONS.includes(
          migration.filename as (typeof API_KEY_SCOPE_MIGRATIONS)[number],
        ),
      )
      .map((migration) => [migration.filename, migration.checksum]),
  );
  if (expectedChecksums.size !== API_KEY_SCOPE_MIGRATIONS.length) {
    throw new Error('Migration files for the API-key scope contract are missing from this image');
  }

  const [constraintRows, ledgerRows, scopeRows] = await Promise.all([
    sql.unsafe(CONSTRAINT_QUERY),
    sql.unsafe(LEDGER_QUERY, [[...API_KEY_SCOPE_MIGRATIONS]]),
    sql.unsafe(SCOPE_DISTRIBUTION_QUERY),
  ]);
  const constraints = constraintRows.map(asScopeConstraint);
  const constraint = constraints.find((item) => item.name === 'api_keys_scope_check') ?? null;
  const constraintScopeValues =
    constraint === null ? [] : scopeValuesFromConstraintDefinition(constraint.definition);
  const ledgerByFilename = new Map(ledgerRows.map(asLedgerRow).map((row) => [row.filename, row]));
  const ledger = API_KEY_SCOPE_MIGRATIONS.map((filename) => {
    const row = ledgerByFilename.get(filename);
    return {
      checksum_matches: row !== undefined && row.checksum === expectedChecksums.get(filename),
      filename,
      present: row !== undefined,
    };
  });
  const scopeDistribution = scopeRows.map(asScopeDistribution);
  const allowedScopes = [...API_KEY_SCOPE_VALUES].sort();
  const unexpectedScopeValues = scopeDistribution
    .map((row) => row.scope)
    .filter(
      (scope) => !API_KEY_SCOPE_VALUES.includes(scope as (typeof API_KEY_SCOPE_VALUES)[number]),
    );
  const unexpectedConstraints = constraints
    .filter((item) => item.name !== 'api_keys_scope_check')
    .map((item) => item.name);

  return {
    constraint,
    constraint_scope_values: constraintScopeValues,
    ledger,
    ok:
      constraint !== null &&
      constraint.validated &&
      unexpectedConstraints.length === 0 &&
      equalStringSets(constraintScopeValues, allowedScopes) &&
      ledger.every((row) => row.checksum_matches) &&
      unexpectedScopeValues.length === 0,
    scope_distribution: scopeDistribution,
    unexpected_constraints: unexpectedConstraints,
    unexpected_scope_values: unexpectedScopeValues,
  };
}

export async function verifyAuthoritativeBudgetLedgerContract({
  migrations,
  sql,
}: {
  migrations: MigrationFile[];
  sql: PhysicalSchemaSqlClient;
}): Promise<AuthoritativeBudgetLedgerContractResult> {
  const migrationsByFilename = new Map(
    migrations.map((migration) => [migration.filename, migration]),
  );
  if (AUTHORITATIVE_BUDGET_MIGRATIONS.some((filename) => !migrationsByFilename.has(filename))) {
    throw new Error(
      'A migration file for the authoritative budget-ledger contract is missing from this image',
    );
  }
  const actualSchemaHead = migrations.at(-1)?.filename ?? null;
  const schemaHead = {
    actual: actualSchemaHead,
    expected: AUTHORITATIVE_BUDGET_SCHEMA_HEAD,
    matches: actualSchemaHead === AUTHORITATIVE_BUDGET_SCHEMA_HEAD,
  };

  const tableNames = [...AUTHORITATIVE_BUDGET_LEDGER_TABLES];
  const rlsTableNames = [...AUTHORITATIVE_BUDGET_RLS_TABLES];
  const [
    ledgerRows,
    tableRows,
    columnRows,
    checkRows,
    keyRows,
    functionRows,
    discoveryFunctionRows,
    runtimeSecurityRows,
    generalAppRuntimeSecurityRows,
    numericRows,
    sequenceRows,
    rlsRows,
    policyRows,
    foreignKeyRows,
    indexRows,
    triggerRows,
  ] = await Promise.all([
    sql.unsafe(LEDGER_QUERY, [[...AUTHORITATIVE_BUDGET_MIGRATIONS]]),
    sql.unsafe(BUDGET_TABLES_QUERY),
    sql.unsafe(BUDGET_COLUMNS_QUERY, [tableNames]),
    sql.unsafe(BUDGET_CHECKS_QUERY, [tableNames]),
    sql.unsafe(BUDGET_KEYS_QUERY, [tableNames]),
    sql.unsafe(BUDGET_FUNCTIONS_QUERY),
    sql.unsafe(BUDGET_DISCOVERY_FUNCTIONS_QUERY),
    sql.unsafe(BUDGET_RUNTIME_SECURITY_QUERY),
    sql.unsafe(GENERAL_APP_RUNTIME_SECURITY_QUERY),
    sql.unsafe(BUDGET_NUMERIC_COLUMNS_QUERY, [tableNames]),
    sql.unsafe(BUDGET_SEQUENCES_QUERY),
    sql.unsafe(BUDGET_RLS_QUERY, [rlsTableNames]),
    sql.unsafe(BUDGET_POLICIES_QUERY, [rlsTableNames]),
    sql.unsafe(BUDGET_TENANT_FOREIGN_KEYS_QUERY, [tableNames]),
    sql.unsafe(BUDGET_INDEXES_QUERY, [tableNames]),
    sql.unsafe(BUDGET_IMMUTABILITY_TRIGGERS_QUERY, [tableNames]),
  ]);

  const ledgerByFilename = new Map(ledgerRows.map(asLedgerRow).map((row) => [row.filename, row]));
  const ledger = AUTHORITATIVE_BUDGET_MIGRATIONS.map((filename) => {
    const installedMigration = ledgerByFilename.get(filename);
    const imageMigration = migrationsByFilename.get(filename);
    const frozenChecksum = AUTHORITATIVE_BUDGET_MIGRATION_SHA256[filename];
    return {
      checksum_matches:
        imageMigration?.checksum === frozenChecksum &&
        installedMigration?.checksum === frozenChecksum,
      filename,
      present: installedMigration !== undefined,
    };
  });

  const installedTables = sortedUnique(tableRows.map((row) => readString(row, 'table_name')));
  const tables = comparePhysicalIdentities({
    actual: installedTables,
    expected: tableNames,
    identity: (tableName) => tableName,
  });

  const ledgerColumnsInstalled = columnRows
    .map(asLedgerColumn)
    .sort((left, right) => ledgerColumnIdentity(left).localeCompare(ledgerColumnIdentity(right)));
  const expectedColumnsByIdentity = new Map(
    AUTHORITATIVE_BUDGET_COLUMNS.map((column) => [ledgerColumnIdentity(column), column]),
  );
  const columns = comparePhysicalIdentities({
    actual: ledgerColumnsInstalled,
    expected: [...expectedColumnsByIdentity.keys()],
    identity: ledgerColumnIdentity,
    invalid: ledgerColumnsInstalled
      .filter((column) => {
        const expected = expectedColumnsByIdentity.get(ledgerColumnIdentity(column));
        return (
          expected !== undefined &&
          (column.data_type !== expected.data_type ||
            column.nullable !== expected.nullable ||
            column.default_kind !== expected.default_kind)
        );
      })
      .map(ledgerColumnIdentity),
  });

  const ledgerChecksInstalled = checkRows
    .map(asLedgerCheck)
    .sort((left, right) => ledgerCheckIdentity(left).localeCompare(ledgerCheckIdentity(right)));
  const expectedChecksByIdentity = new Map(
    AUTHORITATIVE_BUDGET_REQUIRED_CHECKS.map((check) => [ledgerCheckIdentity(check), check]),
  );
  const checkConstraints = comparePhysicalIdentities({
    actual: ledgerChecksInstalled,
    expected: [...expectedChecksByIdentity.keys()],
    identity: ledgerCheckIdentity,
    invalid: ledgerChecksInstalled
      .filter((check) => {
        const expected = expectedChecksByIdentity.get(ledgerCheckIdentity(check));
        return (
          expected !== undefined &&
          (!check.validated || check.definition_hash !== expected.definition_hash)
        );
      })
      .map(ledgerCheckIdentity),
  });

  const ledgerKeysInstalled = keyRows
    .map(asLedgerKey)
    .sort((left, right) => ledgerKeyIdentity(left).localeCompare(ledgerKeyIdentity(right)));
  const expectedKeysByIdentity = new Map(
    AUTHORITATIVE_BUDGET_REQUIRED_KEYS.map((key) => [ledgerKeyIdentity(key), key]),
  );
  const keyConstraints = comparePhysicalIdentities({
    actual: ledgerKeysInstalled,
    expected: [...expectedKeysByIdentity.keys()],
    identity: ledgerKeyIdentity,
    invalid: ledgerKeysInstalled
      .filter((key) => {
        const expected = expectedKeysByIdentity.get(ledgerKeyIdentity(key));
        return (
          expected !== undefined &&
          (!key.validated ||
            key.constraint_type !== expected.constraint_type ||
            key.nulls_not_distinct !== expected.nulls_not_distinct ||
            !sameOrderedStrings(key.columns, expected.columns))
        );
      })
      .map(ledgerKeyIdentity),
  });

  const ledgerFunctionsInstalled = functionRows
    .map(asLedgerFunction)
    .sort((left, right) =>
      ledgerFunctionIdentity(left).localeCompare(ledgerFunctionIdentity(right)),
    );
  const expectedFunctionsByIdentity = new Map(
    AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS.map((helper) => [
      ledgerFunctionIdentity(helper),
      helper,
    ]),
  );
  const helperFunctions = comparePhysicalIdentities({
    actual: ledgerFunctionsInstalled,
    expected: [...expectedFunctionsByIdentity.keys()],
    identity: ledgerFunctionIdentity,
    invalid: ledgerFunctionsInstalled
      .filter((helper) => {
        const expected = expectedFunctionsByIdentity.get(ledgerFunctionIdentity(helper));
        return (
          expected !== undefined &&
          (helper.result_type !== expected.result_type ||
            helper.configuration !== expected.configuration ||
            helper.language !== expected.language ||
            helper.volatility !== expected.volatility ||
            helper.strict !== expected.strict ||
            helper.security_definer !== expected.security_definer ||
            helper.parallel_safety !== expected.parallel_safety ||
            helper.source_hash !== expected.source_hash)
        );
      })
      .map(ledgerFunctionIdentity),
  });

  const discoveryFunctionsInstalled = discoveryFunctionRows
    .map(asDiscoveryFunction)
    .sort((left, right) =>
      ledgerFunctionIdentity(left).localeCompare(ledgerFunctionIdentity(right)),
    );
  const expectedDiscoveryFunctionsByIdentity = new Map(
    AUTHORITATIVE_BUDGET_DISCOVERY_FUNCTIONS.map((helper) => [
      ledgerFunctionIdentity(helper),
      helper,
    ]),
  );
  const discoveryFunctions = comparePhysicalIdentities({
    actual: discoveryFunctionsInstalled,
    expected: [...expectedDiscoveryFunctionsByIdentity.keys()],
    identity: ledgerFunctionIdentity,
    invalid: discoveryFunctionsInstalled
      .filter((helper) => {
        const expected = expectedDiscoveryFunctionsByIdentity.get(ledgerFunctionIdentity(helper));
        return (
          expected !== undefined &&
          (helper.result_type !== expected.result_type ||
            helper.configuration !== expected.configuration ||
            helper.language !== expected.language ||
            helper.volatility !== expected.volatility ||
            helper.strict !== expected.strict ||
            helper.security_definer !== expected.security_definer ||
            helper.parallel_safety !== expected.parallel_safety ||
            helper.source_hash !== expected.source_hash ||
            helper.owner_name !== expected.owner_name ||
            helper.function_kind !== expected.function_kind ||
            helper.returns_set !== expected.returns_set ||
            helper.return_type_oid !== expected.return_type_oid ||
            helper.default_argument_count !== expected.default_argument_count ||
            helper.leakproof !== expected.leakproof ||
            !helper.acl_is_exact ||
            !sameOrderedStrings([...helper.acl_grantees].sort(), [...expected.acl_grantees].sort()))
        );
      })
      .map(ledgerFunctionIdentity),
  });

  if (runtimeSecurityRows.length !== 1) {
    throw new Error('Runtime-security physical attestation returned an invalid row count');
  }
  if (generalAppRuntimeSecurityRows.length !== 1) {
    throw new Error(
      'General-app runtime-security physical attestation returned an invalid row count',
    );
  }
  const runtimeSecurity = asRuntimeSecurity(
    runtimeSecurityRows[0]!,
    generalAppRuntimeSecurityRows[0]!,
  );

  const numericColumns = numericRows
    .map(asNumericColumn)
    .sort((left, right) =>
      ledgerObjectIdentity(left.table_name, left.column_name).localeCompare(
        ledgerObjectIdentity(right.table_name, right.column_name),
      ),
    );
  const numericAuthorityColumns = comparePhysicalIdentities({
    actual: numericColumns,
    expected: [
      ...AUTHORITATIVE_BUDGET_NUMERIC_COLUMNS,
      ...AUTHORITATIVE_BUDGET_WIDE_NUMERIC_COLUMNS,
      ...AUTHORITATIVE_BUDGET_UNBOUNDED_NUMERIC_COLUMNS,
    ],
    identity: (column) => ledgerObjectIdentity(column.table_name, column.column_name),
    invalid: numericColumns
      .filter((column) => {
        const identity = ledgerObjectIdentity(column.table_name, column.column_name);
        if (AUTHORITATIVE_BUDGET_UNBOUNDED_NUMERIC_COLUMNS.includes(identity)) {
          return column.numeric_precision !== null || column.numeric_scale !== null;
        }
        if (AUTHORITATIVE_BUDGET_WIDE_NUMERIC_COLUMNS.includes(identity)) {
          return column.numeric_precision !== 44 || column.numeric_scale !== 18;
        }
        return column.numeric_precision !== 38 || column.numeric_scale !== 18;
      })
      .map((column) => ledgerObjectIdentity(column.table_name, column.column_name)),
  });

  const ledgerSequences = sequenceRows
    .map(asLedgerSequence)
    .sort((left, right) =>
      ledgerSequenceIdentity(left).localeCompare(ledgerSequenceIdentity(right)),
    );
  const expectedSequencesByIdentity = new Map(
    AUTHORITATIVE_BUDGET_REQUIRED_SEQUENCES.map((sequence) => [
      ledgerSequenceIdentity(sequence),
      sequence,
    ]),
  );
  const sequences = comparePhysicalIdentities({
    actual: ledgerSequences,
    expected: [...expectedSequencesByIdentity.keys()],
    identity: ledgerSequenceIdentity,
    invalid: ledgerSequences
      .filter((sequence) => {
        const expected = expectedSequencesByIdentity.get(ledgerSequenceIdentity(sequence));
        return (
          expected !== undefined &&
          (sequence.data_type !== expected.data_type ||
            sequence.start_value !== expected.start_value ||
            sequence.min_value !== expected.min_value ||
            sequence.max_value !== expected.max_value ||
            sequence.increment_by !== expected.increment_by ||
            sequence.cycle !== expected.cycle ||
            sequence.cache_size !== expected.cache_size ||
            sequence.public_has_no_privileges !== expected.public_has_no_privileges ||
            sequence.owned_by_column !== expected.owned_by_column ||
            sequence.owner_name.trim() === '')
        );
      })
      .map(ledgerSequenceIdentity),
  });

  const rlsTables = rlsRows
    .map(asRlsTable)
    .sort((left, right) => left.table_name.localeCompare(right.table_name));
  const rowLevelSecurity = comparePhysicalIdentities({
    actual: rlsTables,
    expected: rlsTableNames,
    identity: (table) => table.table_name,
    invalid: rlsTables
      .filter(
        (table) =>
          !table.rls_enabled ||
          table.rls_forced !== AUTHORITATIVE_BUDGET_FORCED_RLS_TABLE_SET.has(table.table_name),
      )
      .map((table) => table.table_name),
  });

  const tenantPolicies = policyRows
    .map(asTenantPolicy)
    .sort((left, right) =>
      ledgerObjectIdentity(left.table_name, left.policy_name).localeCompare(
        ledgerObjectIdentity(right.table_name, right.policy_name),
      ),
    );
  const expectedPoliciesByIdentity = new Map(
    AUTHORITATIVE_BUDGET_TENANT_POLICIES.map((policy) => [tenantPolicyIdentity(policy), policy]),
  );
  const policies = comparePhysicalIdentities({
    actual: tenantPolicies,
    expected: [...expectedPoliciesByIdentity.keys()],
    identity: tenantPolicyIdentity,
    invalid: tenantPolicies
      .filter((policy) => {
        const expected = expectedPoliciesByIdentity.get(tenantPolicyIdentity(policy));
        return expected !== undefined && !policyMatchesExpectation(policy, expected);
      })
      .map(tenantPolicyIdentity),
  });

  const tenantForeignKeys = foreignKeyRows
    .map(asTenantForeignKey)
    .sort((left, right) =>
      tenantForeignKeyIdentity(left).localeCompare(tenantForeignKeyIdentity(right)),
    );
  const expectedForeignKeysByIdentity = new Map(
    AUTHORITATIVE_BUDGET_TENANT_FOREIGN_KEYS.map((foreignKey) => [
      tenantForeignKeyIdentity(foreignKey),
      foreignKey,
    ]),
  );
  const foreignKeys = comparePhysicalIdentities({
    actual: tenantForeignKeys,
    expected: [...expectedForeignKeysByIdentity.keys()],
    identity: tenantForeignKeyIdentity,
    invalid: tenantForeignKeys
      .filter((foreignKey) => {
        const expected = expectedForeignKeysByIdentity.get(tenantForeignKeyIdentity(foreignKey));
        return (
          expected !== undefined &&
          (foreignKey.parent_table !== expected.parent_table ||
            !sameOrderedStrings(foreignKey.child_columns, expected.child_columns) ||
            !sameOrderedStrings(foreignKey.parent_columns, expected.parent_columns) ||
            foreignKey.child_columns[0] !== 'builder_id' ||
            foreignKey.deferrable !== expected.deferrable ||
            foreignKey.initially_deferred !== expected.initially_deferred ||
            foreignKey.delete_action !== expected.delete_action ||
            foreignKey.update_action !== (expected.update_action ?? 'NO ACTION') ||
            foreignKey.match_type !== (expected.match_type ?? 'SIMPLE') ||
            !foreignKey.validated)
        );
      })
      .map(tenantForeignKeyIdentity),
  });

  const ledgerIndexes = indexRows
    .map(asLedgerIndex)
    .sort((left, right) => ledgerIndexIdentity(left).localeCompare(ledgerIndexIdentity(right)));
  const accountIndexes = ledgerIndexes.filter(
    (index) =>
      index.table_name === AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS.table_name &&
      (index.index_name === AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS.index_name ||
        index.nulls_not_distinct),
  );
  const accountNullsNotDistinct = comparePhysicalIdentities({
    actual: accountIndexes,
    expected: [ledgerIndexIdentity(AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS)],
    identity: ledgerIndexIdentity,
    invalid: accountIndexes
      .filter((index) => !indexMatchesExpectation(index, AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS))
      .map(ledgerIndexIdentity),
  });

  const accountIndexIdentities = new Set(accountIndexes.map(ledgerIndexIdentity));
  const requiredLedgerIndexes = ledgerIndexes.filter(
    (index) => !accountIndexIdentities.has(ledgerIndexIdentity(index)),
  );
  const expectedIndexesByIdentity = new Map(
    AUTHORITATIVE_BUDGET_REQUIRED_INDEXES.map((index) => [ledgerIndexIdentity(index), index]),
  );
  const requiredIndexes = comparePhysicalIdentities({
    actual: requiredLedgerIndexes,
    expected: [...expectedIndexesByIdentity.keys()],
    identity: ledgerIndexIdentity,
    invalid: requiredLedgerIndexes
      .filter((index) => {
        const expected = expectedIndexesByIdentity.get(ledgerIndexIdentity(index));
        return expected !== undefined && !indexMatchesExpectation(index, expected);
      })
      .map(ledgerIndexIdentity),
  });

  const immutabilityTriggerRows = triggerRows
    .map(asImmutabilityTrigger)
    .sort((left, right) => triggerIdentity(left).localeCompare(triggerIdentity(right)));
  const expectedTriggersByIdentity = new Map(
    AUTHORITATIVE_BUDGET_IMMUTABILITY_TRIGGERS.map((trigger) => [
      triggerIdentity(trigger),
      trigger,
    ]),
  );
  const immutabilityTriggers = comparePhysicalIdentities({
    actual: immutabilityTriggerRows,
    expected: [...expectedTriggersByIdentity.keys()],
    identity: triggerIdentity,
    invalid: immutabilityTriggerRows
      .filter((trigger) => {
        const expected = expectedTriggersByIdentity.get(triggerIdentity(trigger));
        return (
          expected !== undefined &&
          (!trigger.enabled ||
            trigger.before !== expected.before ||
            trigger.constraint_trigger !== expected.constraint_trigger ||
            trigger.deferrable !== expected.deferrable ||
            trigger.initially_deferred !== expected.initially_deferred ||
            trigger.row_level !== expected.row_level ||
            trigger.insert_event !== expected.insert_event ||
            trigger.truncate_event !== expected.truncate_event ||
            trigger.function_schema !== 'public' ||
            trigger.function_name !== expected.function_name ||
            trigger.update_event !== expected.update_event ||
            trigger.delete_event !== expected.delete_event)
        );
      })
      .map(triggerIdentity),
  });

  const result: AuthoritativeBudgetLedgerContractResult = {
    account_nulls_not_distinct: accountNullsNotDistinct,
    check_constraints: checkConstraints,
    columns,
    contract: AUTHORITATIVE_BUDGET_LEDGER_CONTRACT,
    discovery_functions: discoveryFunctions,
    immutability_triggers: immutabilityTriggers,
    helper_functions: helperFunctions,
    key_constraints: keyConstraints,
    ledger,
    numeric_authority_columns: numericAuthorityColumns,
    ok: false,
    required_indexes: requiredIndexes,
    row_level_security: rowLevelSecurity,
    runtime_security: runtimeSecurity,
    schema_head: schemaHead,
    sequences,
    tables,
    tenant_foreign_keys: foreignKeys,
    tenant_policies: policies,
  };
  result.ok =
    ledger.every((row) => row.checksum_matches) &&
    result.schema_head.matches &&
    physicalCheckOk(result.tables) &&
    physicalCheckOk(result.columns) &&
    physicalCheckOk(result.check_constraints) &&
    physicalCheckOk(result.discovery_functions) &&
    physicalCheckOk(result.helper_functions) &&
    physicalCheckOk(result.key_constraints) &&
    physicalCheckOk(result.numeric_authority_columns) &&
    physicalCheckOk(result.sequences) &&
    physicalCheckOk(result.row_level_security) &&
    physicalCheckOk(result.tenant_policies) &&
    physicalCheckOk(result.tenant_foreign_keys) &&
    physicalCheckOk(result.account_nulls_not_distinct) &&
    physicalCheckOk(result.required_indexes) &&
    physicalCheckOk(result.immutability_triggers) &&
    Object.values(result.runtime_security).every((safe) => safe);
  return result;
}

export function physicalSchemaResultJson(result: VerifyPhysicalSchemaResult): string {
  return JSON.stringify(result);
}

function logResult(result: VerifyPhysicalSchemaResult, json: boolean): void {
  if (json) {
    console.log(physicalSchemaResultJson(result));
    return;
  }

  if ('contract' in result) {
    console.log(`contract: ${result.contract}`);
    console.log(`status: ${result.ok ? 'in_sync' : 'drift'}`);
    console.log(
      `ledger: ${result.ledger.map((row) => `${row.filename}=${row.checksum_matches ? 'ok' : 'mismatch'}`).join(', ')}`,
    );
    console.log(
      `schema_head: ${result.schema_head.actual ?? '(missing)'}=${result.schema_head.matches ? 'ok' : `expected:${result.schema_head.expected}`}`,
    );
    for (const [name, check] of [
      ['tables', result.tables],
      ['columns', result.columns],
      ['check_constraints', result.check_constraints],
      ['discovery_functions', result.discovery_functions],
      ['helper_functions', result.helper_functions],
      ['key_constraints', result.key_constraints],
      ['numeric_authority_columns', result.numeric_authority_columns],
      ['sequences', result.sequences],
      ['row_level_security', result.row_level_security],
      ['tenant_policies', result.tenant_policies],
      ['tenant_foreign_keys', result.tenant_foreign_keys],
      ['account_nulls_not_distinct', result.account_nulls_not_distinct],
      ['required_indexes', result.required_indexes],
      ['immutability_triggers', result.immutability_triggers],
    ] as const) {
      console.log(
        `${name}: ${physicalCheckOk(check) ? 'ok' : `missing=${check.missing.join(',') || '(none)'} unexpected=${check.unexpected.join(',') || '(none)'} invalid=${check.invalid.join(',') || '(none)'}`}`,
      );
    }
    console.log(
      `runtime_security: ${
        Object.values(result.runtime_security).every((safe) => safe)
          ? 'ok'
          : Object.entries(result.runtime_security)
              .filter(([, safe]) => !safe)
              .map(([name]) => name)
              .join(',')
      }`,
    );
    return;
  }

  console.log(`contract: ${API_KEY_SCOPE_CONTRACT}`);
  console.log(`status: ${result.ok ? 'in_sync' : 'drift'}`);
  console.log(`constraint: ${result.constraint?.name ?? '(missing)'}`);
  console.log(`constraint_scope_values: ${result.constraint_scope_values.join(',') || '(none)'}`);
  console.log(
    `ledger: ${result.ledger.map((row) => `${row.filename}=${row.checksum_matches ? 'ok' : 'mismatch'}`).join(', ')}`,
  );
  console.log(
    `scope_distribution: ${result.scope_distribution.map((row) => `${row.scope}=${row.count}`).join(',') || '(empty)'}`,
  );
}

export async function runPhysicalSchemaVerification({
  args,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  sql,
}: {
  args: VerifyPhysicalSchemaArgs;
  migrationsDir?: string;
  sql: PhysicalSchemaSqlClient;
}): Promise<VerifyPhysicalSchemaResult> {
  const migrations = await listMigrationFiles(migrationsDir);
  const result =
    args.contract === API_KEY_SCOPE_CONTRACT
      ? await verifyApiKeyScopeContract({ migrations, sql })
      : await verifyAuthoritativeBudgetLedgerContract({ migrations, sql });
  logResult(result, args.json);
  return result;
}

function isMainModule(importMetaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && importMetaUrl === pathToFileURL(argvPath).href;
}

async function main(): Promise<void> {
  const args = parseVerifyPhysicalSchemaArgs(process.argv.slice(2));
  const { databaseUrl } = readDbMigrateEnv();
  const sql = postgres(databaseUrl);

  try {
    const result = await runPhysicalSchemaVerification({ args, sql });
    process.exitCode = result.ok ? 0 : 2;
  } finally {
    await sql.end();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch(() => {
    console.error('Physical schema contract verification failed.');
    process.exitCode = 1;
  });
}
