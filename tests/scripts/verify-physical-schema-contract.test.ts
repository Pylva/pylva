import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_SCOPE_MIGRATIONS,
  AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS,
  AUTHORITATIVE_BUDGET_AUTHORITY_ORDER_SEQUENCE,
  AUTHORITATIVE_BUDGET_COLUMNS,
  AUTHORITATIVE_BUDGET_DISCOVERY_FUNCTIONS,
  AUTHORITATIVE_BUDGET_IMMUTABILITY_TRIGGERS,
  AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
  AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
  AUTHORITATIVE_BUDGET_LEDGER_TABLES,
  AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES,
  AUTHORITATIVE_BUDGET_MIGRATIONS,
  AUTHORITATIVE_BUDGET_MIGRATION_SHA256,
  AUTHORITATIVE_BUDGET_NUMERIC_COLUMNS,
  AUTHORITATIVE_BUDGET_REQUIRED_CHECKS,
  AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS,
  AUTHORITATIVE_BUDGET_REQUIRED_KEYS,
  AUTHORITATIVE_BUDGET_REQUIRED_SEQUENCES,
  AUTHORITATIVE_BUDGET_REQUIRED_INDEXES,
  AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
  AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
  AUTHORITATIVE_BUDGET_OWNER_BYPASS_RLS_TABLES,
  AUTHORITATIVE_BUDGET_RLS_TABLES,
  AUTHORITATIVE_BUDGET_SCHEMA_HEAD,
  AUTHORITATIVE_BUDGET_TENANT_FOREIGN_KEYS,
  AUTHORITATIVE_BUDGET_TENANT_POLICIES,
  AUTHORITATIVE_BUDGET_UNBOUNDED_NUMERIC_COLUMNS,
  AUTHORITATIVE_BUDGET_WIDE_NUMERIC_COLUMNS,
  GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
  parseVerifyPhysicalSchemaArgs,
  physicalSchemaResultJson,
  scopeValuesFromConstraintDefinition,
  verifyApiKeyScopeContract,
  verifyAuthoritativeBudgetLedgerContract,
} from '../../scripts/verify-physical-schema-contract.js';

const migrations = API_KEY_SCOPE_MIGRATIONS.map((filename, index) => ({
  checksum: `checksum-${index}`,
  content: '',
  filename,
  phase:
    filename === '048_universal_api_key_scope.sql' ? ('post_roll' as const) : ('pre_roll' as const),
}));

function fakeClient({
  constraintDefinition = "CHECK ((scope = ANY (ARRAY['agent_sdk'::character varying, 'admin_api'::character varying, 'data_import'::character varying, 'universal'::character varying])))",
  constraintName = 'api_keys_scope_check',
  extraConstraints = [] as Array<{
    conname: string;
    convalidated: boolean;
    definition: string;
  }>,
  ledgerRows = migrations.map((migration) => ({
    checksum: migration.checksum,
    filename: migration.filename,
  })),
  scopeRows = [{ count: '3', scope: 'universal' }],
  validated = true,
}: {
  constraintDefinition?: string;
  constraintName?: string;
  extraConstraints?: Array<{
    conname: string;
    convalidated: boolean;
    definition: string;
  }>;
  ledgerRows?: Array<{ checksum: string; filename: string }>;
  scopeRows?: Array<{ count: string; scope: string }>;
  validated?: boolean;
} = {}) {
  return {
    unsafe: vi.fn(async (query: string) => {
      if (query.includes('FROM pg_constraint')) {
        return [
          {
            conname: constraintName,
            convalidated: validated,
            definition: constraintDefinition,
          },
          ...extraConstraints,
        ];
      }
      if (query.includes('FROM schema_migrations')) return ledgerRows;
      if (query.includes('FROM api_keys')) return scopeRows;
      throw new Error(`Unexpected query: ${query}`);
    }),
  };
}

describe('physical API-key schema contract', () => {
  it('parses the explicit contract argument', () => {
    expect(parseVerifyPhysicalSchemaArgs(['--contract', 'api_keys_scope', '--json'])).toEqual({
      contract: 'api_keys_scope',
      json: true,
    });
    expect(parseVerifyPhysicalSchemaArgs(['--', '--contract', 'api_keys_scope'])).toEqual({
      contract: 'api_keys_scope',
      json: false,
    });
    expect(
      parseVerifyPhysicalSchemaArgs(['--contract', 'authoritative_budget_ledger', '--json']),
    ).toEqual({
      contract: 'authoritative_budget_ledger',
      json: true,
    });
    expect(() => parseVerifyPhysicalSchemaArgs([])).toThrow(/required/);
    expect(() => parseVerifyPhysicalSchemaArgs(['--contract', 'other'])).toThrow(/must be/);
  });

  it('extracts PostgreSQL CHECK literals without assuming formatting', () => {
    expect(
      scopeValuesFromConstraintDefinition(
        "CHECK ((scope = ANY (ARRAY['universal'::text, 'agent_sdk'::text, 'universal'::text])))",
      ),
    ).toEqual(['agent_sdk', 'universal']);
  });

  it('passes only when the physical constraint, ledger, and persisted values agree', async () => {
    const sql = fakeClient();
    const result = await verifyApiKeyScopeContract({
      migrations,
      sql,
    });

    expect(result.ok).toBe(true);
    expect(result.ledger).toEqual([
      { checksum_matches: true, filename: '041_rename_api_key_scopes.sql', present: true },
      { checksum_matches: true, filename: '048_universal_api_key_scope.sql', present: true },
    ]);
    expect(
      sql.unsafe.mock.calls
        .map(([query]) => String(query).trim())
        .every((query) => query.startsWith('SELECT')),
    ).toBe(true);
  });

  it('flags a named-only constraint, missing ledger checksum, and unexpected scope value', async () => {
    const result = await verifyApiKeyScopeContract({
      migrations,
      sql: fakeClient({
        constraintDefinition:
          "CHECK ((scope = ANY (ARRAY['agent_sdk'::text, 'admin_api'::text, 'data_import'::text])))",
        ledgerRows: [{ checksum: 'wrong', filename: '048_universal_api_key_scope.sql' }],
        extraConstraints: [
          {
            conname: 'api_keys_scope_legacy_check',
            convalidated: true,
            definition: "CHECK ((scope = 'legacy_unknown'))",
          },
        ],
        scopeRows: [
          { count: '1', scope: 'universal' },
          { count: '1', scope: 'legacy_unknown' },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.constraint_scope_values).not.toContain('universal');
    expect(result.ledger.map((row) => row.checksum_matches)).toEqual([false, false]);
    expect(result.unexpected_scope_values).toEqual(['legacy_unknown']);
    expect(result.unexpected_constraints).toEqual(['api_keys_scope_legacy_check']);
  });
});

const authoritativeLedgerMigrations = [
  {
    checksum: AUTHORITATIVE_BUDGET_MIGRATION_SHA256[AUTHORITATIVE_BUDGET_LEDGER_MIGRATION],
    content: '',
    filename: AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
    phase: 'pre_roll' as const,
  },
  {
    checksum: AUTHORITATIVE_BUDGET_MIGRATION_SHA256[AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION],
    content: '',
    filename: AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
    phase: 'pre_roll' as const,
  },
  {
    checksum: AUTHORITATIVE_BUDGET_MIGRATION_SHA256[AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION],
    content: '',
    filename: AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
    phase: 'pre_roll' as const,
  },
  {
    checksum:
      AUTHORITATIVE_BUDGET_MIGRATION_SHA256[
        AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION
      ],
    content: '',
    filename: AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
    phase: 'pre_roll' as const,
  },
  {
    checksum: AUTHORITATIVE_BUDGET_MIGRATION_SHA256[GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION],
    content: '',
    filename: GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
    phase: 'pre_roll' as const,
  },
];

interface LedgerCatalogRows {
  checkRows: Array<{
    constraint_name: string;
    definition_hash: string;
    table_name: string;
    validated: boolean;
  }>;
  columnRows: Array<{
    column_name: string;
    data_type: string;
    default_expression: string | null;
    nullable: boolean;
    table_name: string;
  }>;
  foreignKeyRows: Array<{
    child_columns: string;
    child_table: string;
    constraint_name: string;
    deferrable: boolean;
    delete_action: string;
    initially_deferred: boolean;
    match_type: string;
    parent_columns: string;
    parent_table: string;
    update_action: string;
    validated: boolean;
  }>;
  functionRows: Array<{
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
  }>;
  discoveryFunctionRows: Array<{
    acl_grantees: string;
    acl_is_exact: boolean;
    configuration: string;
    default_argument_count: string;
    function_kind: string;
    function_name: string;
    identity_arguments: string;
    language: string;
    leakproof: boolean;
    owner_name: string;
    parallel_safety: string;
    result_type: string;
    return_type_oid: string;
    returns_set: boolean;
    security_definer: boolean;
    source_hash: string;
    strict: boolean;
    volatility: string;
  }>;
  indexRows: Array<{
    access_method: string;
    definition: string;
    descending_columns: string;
    included_columns: string;
    index_name: string;
    key_columns: string;
    nulls_not_distinct: boolean;
    nulls_first_columns: string;
    predicate: string | null;
    ready: boolean;
    table_name: string;
    unique: boolean;
    valid: boolean;
  }>;
  keyRows: Array<{
    columns: string;
    constraint_name: string;
    constraint_type: string;
    nulls_not_distinct: boolean;
    table_name: string;
    validated: boolean;
  }>;
  ledgerRows: Array<{ checksum: string; filename: string }>;
  numericRows: Array<{
    column_name: string;
    numeric_precision: string | null;
    numeric_scale: string | null;
    table_name: string;
  }>;
  sequenceRows: Array<{
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
  }>;
  policyRows: Array<{
    command: string;
    permissive: boolean;
    policy_name: string;
    roles: string;
    table_name: string;
    using_expression: string | null;
    with_check_expression: string | null;
  }>;
  rlsRows: Array<{ rls_enabled: boolean; rls_forced: boolean; table_name: string }>;
  generalAppRuntimeSecurityRows: Array<{
    general_app_default_acl_safe: boolean;
    general_app_effective_acl_safe: boolean;
    general_app_fixed_role_attributes_safe: boolean;
    general_app_login_attributes_and_ownership_safe: boolean;
    general_app_login_column_acl_safe: boolean;
    general_app_login_direct_acl_safe: boolean;
    general_app_memberships_safe: boolean;
    general_app_ownership_safe: boolean;
    general_app_partition_function_safe: boolean;
  }>;
  runtimeSecurityRows: Array<{
    discovery_owner_acl_safe: boolean;
    discovery_owner_memberships_safe: boolean;
    fixed_role_attributes_safe: boolean;
    public_acl_safe: boolean;
    runtime_acl_safe: boolean;
  }>;
  tableRows: Array<{ table_name: string }>;
  triggerRows: Array<{
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
  }>;
}

function defaultLedgerCatalogRows(): LedgerCatalogRows {
  const accountUniqueness = AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS;
  const defaultExpressions = {
    empty_object: "'{}'::jsonb",
    empty_uuid_array: 'ARRAY[]::uuid[]',
    false: 'false',
    none: null,
    now: 'now()',
    statement_timestamp: 'statement_timestamp()',
    'text:none': "'none'::character varying",
    'text:pending': "'pending'::character varying",
    'text:unknown': "'unknown'::character varying",
    uuid: 'gen_random_uuid()',
    zero: '0',
    zero_hash: "repeat('0'::text, 64)",
  } as const;
  return {
    checkRows: AUTHORITATIVE_BUDGET_REQUIRED_CHECKS.map((check) => ({
      constraint_name: check.constraint_name,
      definition_hash: check.definition_hash ?? `hash:${check.constraint_name}`,
      table_name: check.table_name,
      validated: true,
    })),
    columnRows: AUTHORITATIVE_BUDGET_COLUMNS.map((column) => ({
      column_name: column.column_name,
      data_type: column.data_type,
      default_expression: defaultExpressions[column.default_kind],
      nullable: column.nullable,
      table_name: column.table_name,
    })),
    foreignKeyRows: AUTHORITATIVE_BUDGET_TENANT_FOREIGN_KEYS.map((foreignKey) => ({
      child_columns: foreignKey.child_columns.join(','),
      child_table: foreignKey.child_table,
      constraint_name: foreignKey.constraint_name,
      deferrable: foreignKey.deferrable,
      delete_action: foreignKey.delete_action,
      initially_deferred: foreignKey.initially_deferred,
      match_type: foreignKey.match_type ?? 'SIMPLE',
      parent_columns: foreignKey.parent_columns.join(','),
      parent_table: foreignKey.parent_table,
      update_action: foreignKey.update_action ?? 'NO ACTION',
      validated: true,
    })),
    functionRows: AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS.map((helper) => ({
      configuration: helper.configuration,
      function_name: helper.function_name,
      identity_arguments: helper.identity_arguments,
      language: helper.language,
      parallel_safety: helper.parallel_safety,
      result_type: helper.result_type,
      security_definer: helper.security_definer,
      source_hash: helper.source_hash ?? `hash:${helper.function_name}`,
      strict: helper.strict,
      volatility: helper.volatility,
    })),
    discoveryFunctionRows: AUTHORITATIVE_BUDGET_DISCOVERY_FUNCTIONS.map((helper) => ({
      acl_grantees: [...helper.acl_grantees].sort().join(','),
      acl_is_exact: true,
      configuration: helper.configuration,
      default_argument_count: String(helper.default_argument_count),
      function_kind: helper.function_kind,
      function_name: helper.function_name,
      identity_arguments: helper.identity_arguments,
      language: helper.language,
      leakproof: helper.leakproof,
      owner_name: helper.owner_name,
      parallel_safety: helper.parallel_safety,
      result_type: helper.result_type,
      return_type_oid: helper.return_type_oid,
      returns_set: helper.returns_set,
      security_definer: helper.security_definer,
      source_hash: helper.source_hash,
      strict: helper.strict,
      volatility: helper.volatility,
    })),
    indexRows: [accountUniqueness, ...AUTHORITATIVE_BUDGET_REQUIRED_INDEXES].map((index) => ({
      access_method: 'btree',
      definition: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.index_name}`,
      descending_columns: (index.descending_columns ?? []).join(','),
      included_columns: (index.included_columns ?? []).join(','),
      index_name: index.index_name,
      key_columns: index.key_columns.join(','),
      nulls_not_distinct: index.nulls_not_distinct,
      nulls_first_columns: (index.descending_columns ?? []).join(','),
      predicate: index.predicate,
      ready: true,
      table_name: index.table_name,
      unique: index.unique,
      valid: true,
    })),
    keyRows: AUTHORITATIVE_BUDGET_REQUIRED_KEYS.map((key) => ({
      columns: key.columns.join(','),
      constraint_name: key.constraint_name,
      constraint_type: key.constraint_type,
      nulls_not_distinct: key.nulls_not_distinct,
      table_name: key.table_name,
      validated: true,
    })),
    ledgerRows: [
      ...authoritativeLedgerMigrations.map(({ checksum, filename }) => ({ checksum, filename })),
    ],
    numericRows: [
      ...AUTHORITATIVE_BUDGET_NUMERIC_COLUMNS.map((identity) => {
        const separator = identity.indexOf('.');
        return {
          column_name: identity.slice(separator + 1),
          numeric_precision: '38',
          numeric_scale: '18',
          table_name: identity.slice(0, separator),
        };
      }),
      ...AUTHORITATIVE_BUDGET_UNBOUNDED_NUMERIC_COLUMNS.map((identity) => {
        const separator = identity.indexOf('.');
        return {
          column_name: identity.slice(separator + 1),
          numeric_precision: null,
          numeric_scale: null,
          table_name: identity.slice(0, separator),
        };
      }),
      ...AUTHORITATIVE_BUDGET_WIDE_NUMERIC_COLUMNS.map((identity) => {
        const separator = identity.indexOf('.');
        return {
          column_name: identity.slice(separator + 1),
          numeric_precision: '44',
          numeric_scale: '18',
          table_name: identity.slice(0, separator),
        };
      }),
    ],
    sequenceRows: AUTHORITATIVE_BUDGET_REQUIRED_SEQUENCES.map((sequence) => ({
      ...sequence,
      owner_name: 'migration_owner',
    })),
    policyRows: AUTHORITATIVE_BUDGET_TENANT_POLICIES.map((policy) => ({
      command: policy.command,
      permissive: policy.permissive,
      policy_name: policy.policy_name,
      roles: policy.roles.join(','),
      table_name: policy.table_name,
      using_expression: policy.using_expression,
      with_check_expression: policy.with_check_expression,
    })),
    rlsRows: AUTHORITATIVE_BUDGET_RLS_TABLES.map((tableName) => ({
      rls_enabled: true,
      rls_forced: AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES.includes(
        tableName as (typeof AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES)[number],
      ),
      table_name: tableName,
    })),
    generalAppRuntimeSecurityRows: [
      {
        general_app_default_acl_safe: true,
        general_app_effective_acl_safe: true,
        general_app_fixed_role_attributes_safe: true,
        general_app_login_attributes_and_ownership_safe: true,
        general_app_login_column_acl_safe: true,
        general_app_login_direct_acl_safe: true,
        general_app_memberships_safe: true,
        general_app_ownership_safe: true,
        general_app_partition_function_safe: true,
      },
    ],
    runtimeSecurityRows: [
      {
        discovery_owner_acl_safe: true,
        discovery_owner_memberships_safe: true,
        fixed_role_attributes_safe: true,
        public_acl_safe: true,
        runtime_acl_safe: true,
      },
    ],
    tableRows: AUTHORITATIVE_BUDGET_LEDGER_TABLES.map((tableName) => ({ table_name: tableName })),
    triggerRows: AUTHORITATIVE_BUDGET_IMMUTABILITY_TRIGGERS.map((trigger) => ({
      before: trigger.before,
      constraint_trigger: trigger.constraint_trigger,
      deferrable: trigger.deferrable,
      definition: `CREATE TRIGGER ${trigger.trigger_name}`,
      delete_event: trigger.delete_event,
      enabled: true,
      function_name: trigger.function_name,
      function_schema: 'public',
      initially_deferred: trigger.initially_deferred,
      insert_event: trigger.insert_event,
      row_level: trigger.row_level,
      table_name: trigger.table_name,
      trigger_name: trigger.trigger_name,
      truncate_event: trigger.truncate_event,
      update_event: trigger.update_event,
    })),
  };
}

function fakeLedgerClient(overrides: Partial<LedgerCatalogRows> = {}) {
  const rows = { ...defaultLedgerCatalogRows(), ...overrides };
  return {
    unsafe: vi.fn(async (query: string) => {
      if (query.includes('ledger-contract:tables')) return rows.tableRows;
      if (query.includes('ledger-contract:columns')) return rows.columnRows;
      if (query.includes('ledger-contract:checks')) return rows.checkRows;
      if (query.includes('ledger-contract:functions')) return rows.functionRows;
      if (query.includes('ledger-contract:discovery-functions')) return rows.discoveryFunctionRows;
      if (query.includes('ledger-contract:general-app-runtime-security')) {
        return rows.generalAppRuntimeSecurityRows;
      }
      if (query.includes('ledger-contract:runtime-security')) return rows.runtimeSecurityRows;
      if (query.includes('ledger-contract:numeric-columns')) return rows.numericRows;
      if (query.includes('ledger-contract:sequences')) return rows.sequenceRows;
      if (query.includes('ledger-contract:rls')) return rows.rlsRows;
      if (query.includes('ledger-contract:policies')) return rows.policyRows;
      if (query.includes('ledger-contract:tenant-foreign-keys')) return rows.foreignKeyRows;
      if (query.includes('ledger-contract:indexes')) return rows.indexRows;
      if (query.includes('ledger-contract:keys')) return rows.keyRows;
      if (query.includes('ledger-contract:immutability-triggers')) return rows.triggerRows;
      if (query.includes('FROM schema_migrations')) return rows.ledgerRows;
      throw new Error(`Unexpected query: ${query}`);
    }),
  };
}

async function verifyLedger(overrides: Partial<LedgerCatalogRows> = {}) {
  return verifyAuthoritativeBudgetLedgerContract({
    migrations: authoritativeLedgerMigrations,
    sql: fakeLedgerClient(overrides),
  });
}

describe('physical authoritative budget-ledger schema contract', () => {
  it('pins the checked-in 050–054 bytes and requires 054 to be the schema head', async () => {
    const migrationsDirectory = new URL('../../db/migrations/', import.meta.url);
    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => filename.endsWith('.sql'))
      .sort();

    expect(filenames.at(-1)).toBe(AUTHORITATIVE_BUDGET_SCHEMA_HEAD);
    for (const filename of AUTHORITATIVE_BUDGET_MIGRATIONS) {
      const content = await readFile(new URL(filename, migrationsDirectory));
      expect(createHash('sha256').update(content).digest('hex')).toBe(
        AUTHORITATIVE_BUDGET_MIGRATION_SHA256[filename],
      );
    }
  });

  it('passes an exact physical schema and serializes deterministically', async () => {
    expect(AUTHORITATIVE_BUDGET_SCHEMA_HEAD).toBe(GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION);
    expect(AUTHORITATIVE_BUDGET_MIGRATIONS).toEqual([
      AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
      AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
      AUTHORITATIVE_BUDGET_RUNTIME_ROLES_MIGRATION,
      AUTHORITATIVE_BUDGET_LEGACY_RLS_COMPATIBILITY_MIGRATION,
      GENERAL_APP_RUNTIME_OWNER_BOUNDARY_MIGRATION,
    ]);
    expect(AUTHORITATIVE_BUDGET_MIGRATION_SHA256).toEqual({
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
    });
    expect(AUTHORITATIVE_BUDGET_LEDGER_TABLES).toHaveLength(9);
    expect(AUTHORITATIVE_BUDGET_COLUMNS).toHaveLength(212);
    expect(AUTHORITATIVE_BUDGET_NUMERIC_COLUMNS).toHaveLength(22);
    expect(AUTHORITATIVE_BUDGET_WIDE_NUMERIC_COLUMNS).toHaveLength(5);
    expect(AUTHORITATIVE_BUDGET_UNBOUNDED_NUMERIC_COLUMNS).toHaveLength(1);
    expect(AUTHORITATIVE_BUDGET_TENANT_FOREIGN_KEYS).toHaveLength(15);
    expect(AUTHORITATIVE_BUDGET_REQUIRED_KEYS).toHaveLength(25);
    expect(AUTHORITATIVE_BUDGET_REQUIRED_CHECKS).toHaveLength(91);
    expect(AUTHORITATIVE_BUDGET_REQUIRED_INDEXES).toHaveLength(28);
    expect(AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS).toHaveLength(43);
    expect(AUTHORITATIVE_BUDGET_DISCOVERY_FUNCTIONS).toHaveLength(2);
    expect(AUTHORITATIVE_BUDGET_RLS_TABLES).toHaveLength(13);
    expect(AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES).toHaveLength(9);
    expect(AUTHORITATIVE_BUDGET_OWNER_BYPASS_RLS_TABLES).toEqual([
      'builders',
      'cost_sources',
      'custom_pricing',
      'rules',
    ]);
    expect(AUTHORITATIVE_BUDGET_TENANT_POLICIES).toHaveLength(17);
    expect(AUTHORITATIVE_BUDGET_IMMUTABILITY_TRIGGERS).toHaveLength(24);
    expect(AUTHORITATIVE_BUDGET_REQUIRED_SEQUENCES).toEqual([
      expect.objectContaining({
        max_value: '9223372036854775806',
        min_value: '1',
        owned_by_column: false,
        public_has_no_privileges: true,
        sequence_name: AUTHORITATIVE_BUDGET_AUTHORITY_ORDER_SEQUENCE,
      }),
    ]);
    expect(AUTHORITATIVE_BUDGET_LEDGER_TABLES).toContain('budget_rule_revisions');
    expect(AUTHORITATIVE_BUDGET_COLUMNS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column_name: 'authority_order',
          data_type: 'bigint',
          default_kind: 'none',
          nullable: false,
          table_name: 'budget_rule_revisions',
        }),
        expect.objectContaining({
          column_name: 'ready_order',
          data_type: 'bigint',
          default_kind: 'none',
          nullable: true,
          table_name: 'budget_control_cutovers',
        }),
      ]),
    );
    expect(AUTHORITATIVE_BUDGET_REQUIRED_KEYS).toContainEqual(
      expect.objectContaining({
        columns: ['authority_order'],
        constraint_name: 'budget_rule_revisions_authority_order_uk',
        constraint_type: 'UNIQUE',
        table_name: 'budget_rule_revisions',
      }),
    );
    expect(AUTHORITATIVE_BUDGET_REQUIRED_CHECKS.map((check) => check.constraint_name)).toEqual(
      expect.arrayContaining([
        'budget_rule_revisions_authority_order_ck',
        'budget_control_cutovers_ready_order_ck',
      ]),
    );
    expect(AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS.map((helper) => helper.function_name)).toContain(
      'pylva_budget_rule_revision_authority_order_guard',
    );
    expect(
      AUTHORITATIVE_BUDGET_IMMUTABILITY_TRIGGERS.map((trigger) => trigger.trigger_name),
    ).toContain('budget_rule_revisions_authority_order_guard');
    expect(
      AUTHORITATIVE_BUDGET_REQUIRED_FUNCTIONS.find(
        (helper) => helper.function_name === 'pylva_budget_allocations_immutability_guard',
      )?.configuration,
    ).toBe('search_path=pg_catalog,public');
    const sql = fakeLedgerClient();
    const expected = await verifyAuthoritativeBudgetLedgerContract({
      migrations: authoritativeLedgerMigrations,
      sql,
    });
    const rows = defaultLedgerCatalogRows();
    const reordered = await verifyLedger({
      checkRows: [...rows.checkRows].reverse(),
      columnRows: [...rows.columnRows].reverse(),
      discoveryFunctionRows: [...rows.discoveryFunctionRows].reverse(),
      foreignKeyRows: [...rows.foreignKeyRows].reverse(),
      functionRows: [...rows.functionRows].reverse(),
      indexRows: [...rows.indexRows].reverse(),
      keyRows: [...rows.keyRows].reverse(),
      numericRows: [...rows.numericRows].reverse(),
      sequenceRows: [...rows.sequenceRows].reverse(),
      policyRows: [...rows.policyRows].reverse(),
      rlsRows: [...rows.rlsRows].reverse(),
      tableRows: [...rows.tableRows].reverse(),
      triggerRows: [...rows.triggerRows].reverse(),
    });

    expect(expected.ok).toBe(true);
    expect(expected.schema_head).toEqual({
      actual: AUTHORITATIVE_BUDGET_SCHEMA_HEAD,
      expected: AUTHORITATIVE_BUDGET_SCHEMA_HEAD,
      matches: true,
    });
    expect(physicalSchemaResultJson(reordered)).toBe(physicalSchemaResultJson(expected));
    expect(JSON.parse(physicalSchemaResultJson(expected))).toMatchObject({
      contract: 'authoritative_budget_ledger',
      ok: true,
    });
    expect(sql.unsafe.mock.calls.every(([query]) => String(query).includes('SELECT'))).toBe(true);
    const runtimeSecurityQuery = sql.unsafe.mock.calls
      .map(([query]) => String(query))
      .find((query) => query.includes('ledger-contract:runtime-security'));
    expect(runtimeSecurityQuery).toContain(
      'WHERE database.datname = pg_catalog.current_database()',
    );
  });

  it('fails closed on a missing or mismatched migration ledger row', async () => {
    const missing = await verifyLedger({ ledgerRows: [] });
    const mismatched = await verifyLedger({
      ledgerRows: authoritativeLedgerMigrations.map(({ checksum, filename }) => ({
        checksum: filename === AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION ? 'drifted' : checksum,
        filename,
      })),
    });

    expect(missing.ok).toBe(false);
    expect(missing.ledger.every((row) => !row.checksum_matches && !row.present)).toBe(true);
    expect(mismatched.ok).toBe(false);
    expect(mismatched.ledger).toContainEqual({
      checksum_matches: false,
      filename: AUTHORITATIVE_BUDGET_RUNTIME_MIGRATION,
      present: true,
    });
  });

  it('fails closed when a frozen migration file or the expected schema head drifts', async () => {
    const imageDrift = await verifyAuthoritativeBudgetLedgerContract({
      migrations: authoritativeLedgerMigrations.map((migration) =>
        migration.filename === AUTHORITATIVE_BUDGET_LEDGER_MIGRATION
          ? { ...migration, checksum: 'mutated-image' }
          : migration,
      ),
      sql: fakeLedgerClient(),
    });
    const headDrift = await verifyAuthoritativeBudgetLedgerContract({
      migrations: [
        ...authoritativeLedgerMigrations,
        {
          checksum: 'future-checksum',
          content: '',
          filename: '055_unreviewed_schema_head.sql',
          phase: 'pre_roll' as const,
        },
      ],
      sql: fakeLedgerClient(),
    });

    expect(imageDrift.ok).toBe(false);
    expect(imageDrift.ledger).toContainEqual({
      checksum_matches: false,
      filename: AUTHORITATIVE_BUDGET_LEDGER_MIGRATION,
      present: true,
    });
    expect(headDrift.ok).toBe(false);
    expect(headDrift.schema_head).toEqual({
      actual: '055_unreviewed_schema_head.sql',
      expected: AUTHORITATIVE_BUDGET_SCHEMA_HEAD,
      matches: false,
    });
  });

  it('flags missing and unexpected budget-ledger tables', async () => {
    const tableRows = defaultLedgerCatalogRows().tableRows.slice(1);
    tableRows.push({ table_name: 'budget_unexpected' });
    const result = await verifyLedger({ tableRows });

    expect(result.ok).toBe(false);
    expect(result.tables.missing).toEqual([AUTHORITATIVE_BUDGET_LEDGER_TABLES[0]]);
    expect(result.tables.unexpected).toEqual(['budget_unexpected']);
  });

  it('flags missing, unexpected, or wrong-width authority numerics', async () => {
    const numericRows = defaultLedgerCatalogRows().numericRows.slice(1);
    numericRows[0] = { ...numericRows[0]!, numeric_scale: '17' };
    numericRows.push({
      column_name: 'unexpected_amount',
      numeric_precision: '38',
      numeric_scale: '18',
      table_name: 'budget_accounts',
    });
    const result = await verifyLedger({ numericRows });

    expect(result.ok).toBe(false);
    expect(result.numeric_authority_columns.missing).toHaveLength(1);
    expect(result.numeric_authority_columns.invalid).toHaveLength(1);
    expect(result.numeric_authority_columns.unexpected).toEqual([
      'budget_accounts.unexpected_amount',
    ]);
  });

  it('requires post-provider actual and overage evidence to remain NUMERIC(44,18)', async () => {
    const numericRows = defaultLedgerCatalogRows().numericRows;
    const index = numericRows.findIndex(
      (row) => row.table_name === 'budget_usage_ledger' && row.column_name === 'actual_cost_usd',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    numericRows[index] = {
      ...numericRows[index]!,
      numeric_precision: '38',
      numeric_scale: '18',
    };
    const result = await verifyLedger({ numericRows });

    expect(result.ok).toBe(false);
    expect(result.numeric_authority_columns.invalid).toEqual([
      'budget_usage_ledger.actual_cost_usd',
    ]);
  });

  it('requires the committed account accumulator to remain unconstrained NUMERIC', async () => {
    const numericRows = defaultLedgerCatalogRows().numericRows;
    const index = numericRows.findIndex(
      (row) => row.table_name === 'budget_accounts' && row.column_name === 'committed_usd',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    numericRows[index] = {
      ...numericRows[index]!,
      numeric_precision: '38',
      numeric_scale: '18',
    };
    const result = await verifyLedger({ numericRows });

    expect(result.ok).toBe(false);
    expect(result.numeric_authority_columns.invalid).toEqual(['budget_accounts.committed_usd']);
  });

  it('rejects sequence drift, PUBLIC privileges, cycling, or column ownership', async () => {
    const sequenceRows = defaultLedgerCatalogRows().sequenceRows;
    sequenceRows[0] = {
      ...sequenceRows[0]!,
      cycle: true,
      max_value: '9223372036854775807',
      owned_by_column: true,
      public_has_no_privileges: false,
    };
    const result = await verifyLedger({ sequenceRows });

    expect(result.ok).toBe(false);
    expect(result.sequences.invalid).toEqual([AUTHORITATIVE_BUDGET_AUTHORITY_ORDER_SEQUENCE]);
  });

  it('rejects a missing authority-order sequence and any unreviewed budget sequence', async () => {
    const sequenceRows = defaultLedgerCatalogRows().sequenceRows.map((sequence) => ({
      ...sequence,
      sequence_name: 'pylva_budget_unreviewed_seq',
    }));
    const result = await verifyLedger({ sequenceRows });

    expect(result.ok).toBe(false);
    expect(result.sequences.missing).toEqual([AUTHORITATIVE_BUDGET_AUTHORITY_ORDER_SEQUENCE]);
    expect(result.sequences.unexpected).toEqual(['pylva_budget_unreviewed_seq']);
  });

  it('flags column type, nullability, default, missing, and unexpected drift', async () => {
    const columnRows = defaultLedgerCatalogRows().columnRows.slice(1);
    columnRows[0] = {
      ...columnRows[0]!,
      data_type: 'text',
      default_expression: 'clock_timestamp()',
      nullable: !columnRows[0]!.nullable,
    };
    columnRows.push({
      column_name: 'unexpected_column',
      data_type: 'uuid',
      default_expression: null,
      nullable: true,
      table_name: 'budget_accounts',
    });
    const result = await verifyLedger({ columnRows });

    expect(result.ok).toBe(false);
    expect(result.columns.missing).toHaveLength(1);
    expect(result.columns.invalid).toHaveLength(1);
    expect(result.columns.unexpected).toEqual(['budget_accounts.unexpected_column']);
  });

  it('rejects restoring the removed opening-balance default', async () => {
    const columnRows = defaultLedgerCatalogRows().columnRows;
    const index = columnRows.findIndex(
      (row) => row.table_name === 'budget_accounts' && row.column_name === 'opening_committed_usd',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    columnRows[index] = { ...columnRows[index]!, default_expression: '0' };
    const result = await verifyLedger({ columnRows });

    expect(result.ok).toBe(false);
    expect(result.columns.invalid).toEqual(['budget_accounts.opening_committed_usd']);
  });

  it('flags missing, unvalidated, and unexpected CHECK constraints', async () => {
    const checkRows = defaultLedgerCatalogRows().checkRows.slice(1);
    checkRows[0] = { ...checkRows[0]!, validated: false };
    checkRows.push({
      constraint_name: 'budget_accounts_unexpected_ck',
      definition_hash: 'unexpected-hash',
      table_name: 'budget_accounts',
      validated: true,
    });
    const result = await verifyLedger({ checkRows });

    expect(result.ok).toBe(false);
    expect(result.check_constraints.missing).toHaveLength(1);
    expect(result.check_constraints.invalid).toHaveLength(1);
    expect(result.check_constraints.unexpected).toEqual([
      'budget_accounts.budget_accounts_unexpected_ck',
    ]);
  });

  it('flags CHECK-body fingerprint drift in Unicode and blank-string protections', async () => {
    const checkRows = defaultLedgerCatalogRows().checkRows;
    const index = checkRows.findIndex(
      (row) =>
        row.table_name === 'budget_reservations' &&
        row.constraint_name === 'budget_reservations_identifiers_ck',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    checkRows[index] = { ...checkRows[index]!, definition_hash: '0'.repeat(64) };
    const result = await verifyLedger({ checkRows });

    expect(result.ok).toBe(false);
    expect(result.check_constraints.invalid).toEqual([
      'budget_reservations.budget_reservations_identifiers_ck',
    ]);
  });

  it('flags drift in shadow-unavailable and typed-cutover CHECK bodies', async () => {
    const checkRows = defaultLedgerCatalogRows().checkRows;
    for (const [tableName, constraintName] of [
      ['budget_reservations', 'budget_reservations_decision_reason_ck'],
      ['budget_control_cutovers', 'budget_control_cutovers_lifecycle_ck'],
      ['budget_control_cutovers', 'budget_control_cutovers_ready_order_ck'],
      ['budget_rule_revisions', 'budget_rule_revisions_authority_order_ck'],
    ] as const) {
      const index = checkRows.findIndex(
        (row) => row.table_name === tableName && row.constraint_name === constraintName,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      checkRows[index] = { ...checkRows[index]!, definition_hash: '0'.repeat(64) };
    }
    const result = await verifyLedger({ checkRows });

    expect(result.ok).toBe(false);
    expect(result.check_constraints.invalid).toEqual([
      'budget_control_cutovers.budget_control_cutovers_lifecycle_ck',
      'budget_control_cutovers.budget_control_cutovers_ready_order_ck',
      'budget_reservations.budget_reservations_decision_reason_ck',
      'budget_rule_revisions.budget_rule_revisions_authority_order_ck',
    ]);
  });

  it('rejects pre-widen settlement fingerprints after migration 051 reparses checks', async () => {
    const checkRows = defaultLedgerCatalogRows().checkRows;
    const staleHashes = new Map([
      [
        'budget_reservation_allocations_settlement_math_ck',
        '91873e4ef98a7429e8dc1cf2297283d6f4384172ac45b9339ece1866aad3b05b',
      ],
      [
        'budget_reservations_settlement_math_ck',
        '3e767f5b1294ab6b56dda17a62b6ec382cc5e9d56f1a795787514e351e7c3e96',
      ],
    ]);
    for (const row of checkRows) {
      const staleHash = staleHashes.get(row.constraint_name);
      if (staleHash !== undefined) row.definition_hash = staleHash;
    }
    const result = await verifyLedger({ checkRows });

    expect(result.ok).toBe(false);
    expect(result.check_constraints.invalid).toEqual([
      'budget_reservation_allocations.budget_reservation_allocations_settlement_math_ck',
      'budget_reservations.budget_reservations_settlement_math_ck',
    ]);
  });

  it('flags missing, weakened, and unexpected helper functions', async () => {
    const functionRows = defaultLedgerCatalogRows().functionRows.slice(1);
    functionRows[0] = { ...functionRows[0]!, volatility: 'VOLATILE' };
    functionRows.push({
      configuration: 'search_path=pg_catalog,public',
      function_name: 'pylva_budget_unexpected',
      identity_arguments: '',
      language: 'plpgsql',
      parallel_safety: 'UNSAFE',
      result_type: 'trigger',
      security_definer: false,
      source_hash: 'unexpected-hash',
      strict: false,
      volatility: 'VOLATILE',
    });
    const result = await verifyLedger({ functionRows });

    expect(result.ok).toBe(false);
    expect(result.helper_functions.missing).toHaveLength(1);
    expect(result.helper_functions.invalid).toHaveLength(1);
    expect(result.helper_functions.unexpected).toEqual(['pylva_budget_unexpected()']);
  });

  it('pins discovery function ownership, body, metadata, and exact EXECUTE ACLs', async () => {
    const discoveryFunctionRows = defaultLedgerCatalogRows().discoveryFunctionRows;
    discoveryFunctionRows[0] = {
      ...discoveryFunctionRows[0]!,
      acl_is_exact: false,
      owner_name: 'migration_owner',
      source_hash: '0'.repeat(64),
    };
    const result = await verifyLedger({ discoveryFunctionRows });

    expect(result.ok).toBe(false);
    expect(result.discovery_functions.invalid).toEqual([
      `${discoveryFunctionRows[0]!.function_name}(${discoveryFunctionRows[0]!.identity_arguments})`,
    ]);
  });

  it('fails closed on any fixed-role, membership, ACL, or PUBLIC privilege drift', async () => {
    const runtimeSecurityRows = defaultLedgerCatalogRows().runtimeSecurityRows;
    runtimeSecurityRows[0] = {
      ...runtimeSecurityRows[0]!,
      discovery_owner_memberships_safe: false,
      public_acl_safe: false,
      runtime_acl_safe: false,
    };
    const result = await verifyLedger({ runtimeSecurityRows });

    expect(result.ok).toBe(false);
    expect(result.runtime_security).toMatchObject(runtimeSecurityRows[0]!);
  });

  it.each([
    ['membership graph', 'general_app_memberships_safe'],
    ['fixed-owner relation/function ownership', 'general_app_ownership_safe'],
    ['login column ACL', 'general_app_login_column_acl_safe'],
    ['owner/login default ACL', 'general_app_default_acl_safe'],
    ['partition-function configuration', 'general_app_partition_function_safe'],
  ] as const)('fails closed on general-app %s drift', async (_label, field) => {
    const generalAppRuntimeSecurityRows = defaultLedgerCatalogRows().generalAppRuntimeSecurityRows;
    generalAppRuntimeSecurityRows[0] = {
      ...generalAppRuntimeSecurityRows[0]!,
      [field]: false,
    };

    const result = await verifyLedger({ generalAppRuntimeSecurityRows });

    expect(result.ok).toBe(false);
    expect(result.runtime_security[field]).toBe(false);
  });

  it('flags outbox renewal helper-body fingerprint drift', async () => {
    const functionRows = defaultLedgerCatalogRows().functionRows;
    const index = functionRows.findIndex(
      (row) => row.function_name === 'pylva_budget_outbox_immutability_guard',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    functionRows[index] = { ...functionRows[index]!, source_hash: '0'.repeat(64) };
    const result = await verifyLedger({ functionRows });

    expect(result.ok).toBe(false);
    expect(result.helper_functions.invalid).toEqual(['pylva_budget_outbox_immutability_guard()']);
  });

  it('flags authority-order insert-guard body drift', async () => {
    const functionRows = defaultLedgerCatalogRows().functionRows;
    const index = functionRows.findIndex(
      (row) => row.function_name === 'pylva_budget_rule_revision_authority_order_guard',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    functionRows[index] = { ...functionRows[index]!, source_hash: '0'.repeat(64) };
    const result = await verifyLedger({ functionRows });

    expect(result.ok).toBe(false);
    expect(result.helper_functions.invalid).toEqual([
      'pylva_budget_rule_revision_authority_order_guard()',
    ]);
  });

  it('flags loss of the pinned allocation-guard search path', async () => {
    const functionRows = defaultLedgerCatalogRows().functionRows;
    const index = functionRows.findIndex(
      (row) => row.function_name === 'pylva_budget_allocations_immutability_guard',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    functionRows[index] = { ...functionRows[index]!, configuration: '' };
    const result = await verifyLedger({ functionRows });

    expect(result.ok).toBe(false);
    expect(result.helper_functions.invalid).toEqual([
      'pylva_budget_allocations_immutability_guard()',
    ]);
  });

  it('requires the activation-boundary helper to stay STABLE and search-path pinned', async () => {
    const functionRows = defaultLedgerCatalogRows().functionRows;
    const index = functionRows.findIndex(
      (row) => row.function_name === 'pylva_budget_builder_next_activation_boundary',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    functionRows[index] = {
      ...functionRows[index]!,
      configuration: '',
      volatility: 'VOLATILE',
    };
    const result = await verifyLedger({ functionRows });

    expect(result.ok).toBe(false);
    expect(result.helper_functions.invalid).toEqual([
      'pylva_budget_builder_next_activation_boundary(tenant_id uuid, activation_anchor timestamp with time zone)',
    ]);
  });

  it('flags missing, reordered, and unexpected primary or unique keys', async () => {
    const keyRows = defaultLedgerCatalogRows().keyRows.slice(1);
    keyRows[0] = {
      ...keyRows[0]!,
      columns: keyRows[0]!.columns.split(',').reverse().join(','),
    };
    keyRows.push({
      columns: 'builder_id,id',
      constraint_name: 'budget_accounts_unexpected_uk',
      constraint_type: 'UNIQUE',
      nulls_not_distinct: false,
      table_name: 'budget_accounts',
      validated: true,
    });
    const result = await verifyLedger({ keyRows });

    expect(result.ok).toBe(false);
    expect(result.key_constraints.missing).toHaveLength(1);
    expect(result.key_constraints.invalid).toHaveLength(1);
    expect(result.key_constraints.unexpected).toEqual([
      'budget_accounts.budget_accounts_unexpected_uk',
    ]);
  });

  it('requires authority_order to remain globally unique rather than tenant-scoped', async () => {
    const keyRows = defaultLedgerCatalogRows().keyRows;
    const index = keyRows.findIndex(
      (row) => row.constraint_name === 'budget_rule_revisions_authority_order_uk',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    keyRows[index] = { ...keyRows[index]!, columns: 'builder_id,authority_order' };
    const result = await verifyLedger({ keyRows });

    expect(result.ok).toBe(false);
    expect(result.key_constraints.invalid).toEqual([
      'budget_rule_revisions.budget_rule_revisions_authority_order_uk',
    ]);
  });

  it('flags disabled RLS and an incomplete or additional tenant policy', async () => {
    const rows = defaultLedgerCatalogRows();
    const rlsRows = rows.rlsRows.map((row, index) =>
      index === 0 ? { ...row, rls_enabled: false } : row,
    );
    const policyRows = rows.policyRows.slice(1);
    policyRows[0] = { ...policyRows[0]!, with_check_expression: null };
    policyRows.push({
      ...rows.policyRows[0]!,
      policy_name: 'budget_accounts_unexpected',
    });
    const result = await verifyLedger({ policyRows, rlsRows });

    expect(result.ok).toBe(false);
    expect(result.row_level_security.invalid).toEqual([rows.rlsRows[0]!.table_name]);
    expect(result.tenant_policies.missing).toEqual([
      `${rows.policyRows[0]!.table_name}.${rows.policyRows[0]!.policy_name}`,
    ]);
    expect(result.tenant_policies.invalid).toHaveLength(1);
    expect(result.tenant_policies.unexpected).toEqual([
      `${rows.policyRows[0]!.table_name}.budget_accounts_unexpected`,
    ]);
  });

  it('requires FORCE on the nine authoritative tables and NO FORCE on the four owner catalogs', async () => {
    const rows = defaultLedgerCatalogRows();
    const forcedTable = AUTHORITATIVE_BUDGET_FORCED_RLS_TABLES[0];
    const ownerBypassTable = AUTHORITATIVE_BUDGET_OWNER_BYPASS_RLS_TABLES[0];
    const rlsRows = rows.rlsRows.map((row) => {
      if (row.table_name === forcedTable) return { ...row, rls_forced: false };
      if (row.table_name === ownerBypassTable) return { ...row, rls_forced: true };
      return row;
    });

    const result = await verifyLedger({ rlsRows });

    expect(result.ok).toBe(false);
    expect(result.row_level_security.invalid).toEqual(
      [forcedTable, ownerBypassTable].sort((left, right) => left.localeCompare(right)),
    );
  });

  it('pins paired permissive and restrictive discovery-policy ceilings', async () => {
    const policyRows = defaultLedgerCatalogRows().policyRows;
    const policyIndex = policyRows.findIndex(
      (policy) => policy.policy_name === 'budget_cost_event_outbox_projection_discovery_limit',
    );
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    policyRows[policyIndex] = {
      ...policyRows[policyIndex]!,
      permissive: true,
      roles: 'public',
    };
    const result = await verifyLedger({ policyRows });

    expect(result.ok).toBe(false);
    expect(result.tenant_policies.invalid).toEqual([
      'budget_cost_event_outbox.budget_cost_event_outbox_projection_discovery_limit',
    ]);
  });

  it('flags a tenant foreign key that drops builder_id', async () => {
    const foreignKeyRows = defaultLedgerCatalogRows().foreignKeyRows;
    foreignKeyRows[0] = {
      ...foreignKeyRows[0]!,
      child_columns: foreignKeyRows[0]!.child_columns.split(',').slice(1).join(','),
    };
    const result = await verifyLedger({ foreignKeyRows });

    expect(result.ok).toBe(false);
    expect(result.tenant_foreign_keys.invalid).toEqual([
      `${foreignKeyRows[0]!.child_table}.${foreignKeyRows[0]!.constraint_name}`,
    ]);
  });

  it('flags weakened foreign-key deletion and deferral semantics', async () => {
    const foreignKeyRows = defaultLedgerCatalogRows().foreignKeyRows;
    foreignKeyRows[0] = {
      ...foreignKeyRows[0]!,
      deferrable: false,
      delete_action: 'CASCADE',
      initially_deferred: false,
    };
    const result = await verifyLedger({ foreignKeyRows });

    expect(result.ok).toBe(false);
    expect(result.tenant_foreign_keys.invalid).toEqual([
      `${foreignKeyRows[0]!.child_table}.${foreignKeyRows[0]!.constraint_name}`,
    ]);
  });

  it('requires opening evidence to retain its deferred tenant-qualified account link', async () => {
    const foreignKeyRows = defaultLedgerCatalogRows().foreignKeyRows;
    const index = foreignKeyRows.findIndex(
      (row) => row.constraint_name === 'budget_account_opening_evidence_account_fk',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    foreignKeyRows[index] = {
      ...foreignKeyRows[index]!,
      child_columns: 'account_id',
      deferrable: false,
      initially_deferred: false,
    };
    const result = await verifyLedger({ foreignKeyRows });

    expect(result.ok).toBe(false);
    expect(result.tenant_foreign_keys.invalid).toEqual([
      'budget_account_opening_evidence.budget_account_opening_evidence_account_fk',
    ]);
  });

  it('flags account uniqueness without NULLS NOT DISTINCT', async () => {
    const indexRows = defaultLedgerCatalogRows().indexRows;
    indexRows[0] = { ...indexRows[0]!, nulls_not_distinct: false };
    const result = await verifyLedger({ indexRows });

    expect(result.ok).toBe(false);
    expect(result.account_nulls_not_distinct.invalid).toEqual([
      `budget_accounts.${AUTHORITATIVE_BUDGET_ACCOUNT_UNIQUENESS.index_name}`,
    ]);
  });

  it('flags missing, structurally drifted, and unexpected worker or terminal indexes', async () => {
    const indexRows = defaultLedgerCatalogRows().indexRows;
    indexRows.splice(1, 1);
    indexRows[1] = { ...indexRows[1]!, predicate: 'false' };
    indexRows.push({
      access_method: 'btree',
      definition: 'CREATE INDEX idx_unexpected',
      descending_columns: '',
      included_columns: '',
      index_name: 'idx_unexpected',
      key_columns: 'builder_id',
      nulls_not_distinct: false,
      nulls_first_columns: '',
      predicate: 'true',
      ready: true,
      table_name: 'budget_reservations',
      unique: false,
      valid: true,
    });
    const result = await verifyLedger({ indexRows });

    expect(result.ok).toBe(false);
    expect(result.required_indexes.missing).toHaveLength(1);
    expect(result.required_indexes.invalid).toHaveLength(1);
    expect(result.required_indexes.unexpected).toEqual(['budget_reservations.idx_unexpected']);
  });

  it('flags a worker index whose sort or NULL ordering drifts', async () => {
    const indexRows = defaultLedgerCatalogRows().indexRows;
    const index = indexRows.findIndex((row) => row.descending_columns !== '');
    expect(index).toBeGreaterThanOrEqual(0);
    indexRows[index] = {
      ...indexRows[index]!,
      descending_columns: '',
      nulls_first_columns: '',
    };
    const result = await verifyLedger({ indexRows });

    expect(result.ok).toBe(false);
    expect(result.required_indexes.invalid).toEqual([
      `${indexRows[index]!.table_name}.${indexRows[index]!.index_name}`,
    ]);
  });

  it('flags a missing or weakened immutability trigger', async () => {
    const triggerRows = defaultLedgerCatalogRows().triggerRows.slice(1);
    triggerRows[0] = { ...triggerRows[0]!, enabled: false };
    const result = await verifyLedger({ triggerRows });

    expect(result.ok).toBe(false);
    expect(result.immutability_triggers.missing).toHaveLength(1);
    expect(result.immutability_triggers.invalid).toHaveLength(1);
  });

  it('flags a constraint trigger that is no longer deferred', async () => {
    const triggerRows = defaultLedgerCatalogRows().triggerRows;
    const triggerIndex = triggerRows.findIndex((row) => row.constraint_trigger);
    expect(triggerIndex).toBeGreaterThanOrEqual(0);
    triggerRows[triggerIndex] = {
      ...triggerRows[triggerIndex]!,
      initially_deferred: false,
    };
    const result = await verifyLedger({ triggerRows });

    expect(result.ok).toBe(false);
    expect(result.immutability_triggers.invalid).toEqual([
      `${triggerRows[triggerIndex]!.table_name}.${triggerRows[triggerIndex]!.trigger_name}`,
    ]);
  });

  it('requires the authority-order allocator to remain an enabled BEFORE INSERT trigger', async () => {
    const triggerRows = defaultLedgerCatalogRows().triggerRows;
    const index = triggerRows.findIndex(
      (row) => row.trigger_name === 'budget_rule_revisions_authority_order_guard',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    triggerRows[index] = { ...triggerRows[index]!, before: false, enabled: false };
    const result = await verifyLedger({ triggerRows });

    expect(result.ok).toBe(false);
    expect(result.immutability_triggers.invalid).toEqual([
      'budget_rule_revisions.budget_rule_revisions_authority_order_guard',
    ]);
  });
});
