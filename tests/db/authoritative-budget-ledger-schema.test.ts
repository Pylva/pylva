import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import {
  budgetAccounts,
  budgetCostEventOutbox,
  budgetReservationAllocations,
  budgetReservations,
  budgetReservationTransitions,
  budgetRuleRevisions,
  budgetUsageLedger,
} from '../../src/lib/db/schema.js';

const dialect = new PgDialect();

const expectedColumns = new Map<PgTable, string[]>([
  [
    budgetAccounts,
    [
      'builder_id',
      'id',
      'rule_key',
      'enforcement',
      'limit_usd',
      'scope',
      'subject_customer_id',
      'period',
      'period_start',
      'period_end',
      'initial_rule_revision_id',
      'initial_rule_snapshot',
      'initial_rule_snapshot_hash',
      'opening_committed_usd',
      'committed_usd',
      'reserved_usd',
      'unresolved_usd',
      'version',
      'created_at',
      'updated_at',
    ],
  ],
  [
    budgetRuleRevisions,
    [
      'builder_id',
      'id',
      'rule_key',
      'revision',
      'authority_order',
      'scope',
      'target_customer_id',
      'period',
      'enforcement',
      'limit_usd',
      'config_snapshot',
      'config_snapshot_hash',
      'active_from',
      'retired_at',
      'retirement_reason',
      'created_at',
    ],
  ],
  [
    budgetReservations,
    [
      'builder_id',
      'decision_id',
      'reservation_id',
      'operation_id',
      'schema_version',
      'request_hash',
      'request_snapshot',
      'mode',
      'kind',
      'customer_id',
      'trace_id',
      'span_id',
      'parent_span_id',
      'step_name',
      'framework',
      'reservation_ttl_seconds',
      'provider',
      'model',
      'estimated_input_tokens',
      'max_output_tokens',
      'cost_source_slug',
      'tool_name',
      'metric',
      'maximum_value',
      'decision',
      'decision_reason',
      'would_have_denied',
      'state',
      'pricing_snapshot',
      'pricing_snapshot_hash',
      'requested_usd',
      'reserved_usd',
      'actual_usd',
      'released_usd',
      'overage_usd',
      'remaining_usd',
      'deciding_account_id',
      'reserve_response_snapshot',
      'rule_revision_ids',
      'rule_set_hash',
      'authorization_transaction_id',
      'expires_at',
      'reserved_at',
      'refused_at',
      'committed_at',
      'released_at',
      'unresolved_at',
      'unresolved_reason',
      'state_version',
      'created_at',
      'updated_at',
    ],
  ],
  [
    budgetReservationAllocations,
    [
      'builder_id',
      'id',
      'reservation_decision_id',
      'account_id',
      'rule_key',
      'rule_revision_id',
      'rule_snapshot',
      'rule_snapshot_hash',
      'enforcement',
      'evaluation_order',
      'is_deciding',
      'account_version_before',
      'held_at_reserve',
      'status',
      'committed_before_usd',
      'reserved_before_usd',
      'unresolved_before_usd',
      'requested_usd',
      'projected_usd',
      'limit_usd',
      'remaining_usd',
      'authorized_usd',
      'actual_usd',
      'released_usd',
      'unresolved_usd',
      'overage_usd',
      'created_at',
      'updated_at',
    ],
  ],
  [
    budgetReservationTransitions,
    [
      'builder_id',
      'id',
      'reservation_decision_id',
      'type',
      'extension_id',
      'release_reason',
      'request_hash',
      'request_snapshot',
      'response_snapshot',
      'from_state',
      'to_state',
      'from_state_version',
      'to_state_version',
      'from_expires_at',
      'to_expires_at',
      'extend_by_seconds',
      'occurred_at',
    ],
  ],
  [
    budgetUsageLedger,
    [
      'builder_id',
      'id',
      'reservation_decision_id',
      'operation_id',
      'cost_event_id',
      'customer_id',
      'trace_id',
      'span_id',
      'parent_span_id',
      'step_name',
      'framework',
      'sdk_version',
      'sdk_language',
      'kind',
      'provider',
      'model',
      'actual_input_tokens',
      'actual_output_tokens',
      'cost_source_slug',
      'tool_name',
      'metric',
      'actual_value',
      'status',
      'latency_ms',
      'stream_aborted',
      'actual_cost_usd',
      'pricing_snapshot',
      'pricing_snapshot_hash',
      'usage_snapshot',
      'usage_snapshot_hash',
      'cost_source',
      'instrumentation_tier',
      'is_demo',
      'retention_days',
      'billing_retention_days',
      'metadata',
      'committed_at',
      'retain_until',
      'details_purged_at',
      'created_at',
    ],
  ],
  [
    budgetCostEventOutbox,
    [
      'builder_id',
      'id',
      'usage_ledger_id',
      'cost_event_id',
      'payload_schema_version',
      'payload',
      'payload_hash',
      'status',
      'attempts',
      'available_at',
      'locked_at',
      'lock_expires_at',
      'lock_owner',
      'last_attempt_at',
      'projected_at',
      'projection_verified_at',
      'payload_purged_at',
      'last_error_code',
      'last_error_message',
      'created_at',
      'updated_at',
    ],
  ],
]);

function tableConfig(table: PgTable) {
  return getTableConfig(table);
}

function names(columns: ReadonlyArray<{ name: string }>): string[] {
  return columns.map((column) => column.name);
}

function expectType(table: PgTable, name: string, sqlType: string): void {
  const column = tableConfig(table).columns.find((candidate) => candidate.name === name);
  expect(column, `${tableConfig(table).name}.${name}`).toBeDefined();
  expect(column!.getSQLType(), `${tableConfig(table).name}.${name}`).toBe(sqlType);
}

function dataType(table: PgTable, name: string): string {
  const column = tableConfig(table).columns.find((candidate) => candidate.name === name);
  expect(column, `${tableConfig(table).name}.${name}`).toBeDefined();
  return column!.dataType;
}

function foreignKeyShape(table: PgTable, name: string) {
  const key = tableConfig(table).foreignKeys.find((candidate) => candidate.getName() === name);
  expect(key, name).toBeDefined();
  const reference = key!.reference();
  return {
    local: names(reference.columns),
    foreignTable: tableConfig(reference.foreignTable).name,
    foreign: names(reference.foreignColumns),
    onDelete: key!.onDelete,
  };
}

function checkSql(table: PgTable, name: string): string {
  const constraint = tableConfig(table).checks.find((candidate) => candidate.name === name);
  expect(constraint, name).toBeDefined();
  return dialect.sqlToQuery(constraint!.value).sql;
}

function checkNames(table: PgTable): string[] {
  return tableConfig(table)
    .checks.map((constraint) => constraint.name)
    .sort();
}

function defaultValue(table: PgTable, name: string): unknown {
  const column = tableConfig(table).columns.find((candidate) => candidate.name === name);
  expect(column, `${tableConfig(table).name}.${name}`).toBeDefined();
  const value = column!.default;
  return value instanceof SQL ? dialect.sqlToQuery(value).sql : value;
}

function indexShape(table: PgTable, name: string) {
  const candidate = tableConfig(table).indexes.find((index) => index.config.name === name);
  expect(candidate, name).toBeDefined();
  return {
    columns: candidate!.config.columns.map((column) => {
      const indexed = column as {
        indexConfig?: { nulls?: string; order?: string };
        name?: string;
      };
      const order = indexed.indexConfig?.order === 'desc' ? ':desc' : '';
      const nulls = indexed.indexConfig?.nulls === 'first' ? ':nulls-first' : '';
      return `${indexed.name}${order}${nulls}`;
    }),
    unique: candidate!.config.unique,
    where: candidate!.config.where ? dialect.sqlToQuery(candidate!.config.where).sql : undefined,
  };
}

function uniqueShapes(table: PgTable) {
  return tableConfig(table).uniqueConstraints.map((constraint) => ({
    name: constraint.getName(),
    columns: names(constraint.columns),
    nullsNotDistinct: constraint.nullsNotDistinct,
  }));
}

describe('authoritative budget-control Drizzle mirror', () => {
  it('exports the exact canonical columns for all seven ledger tables', () => {
    expect([...expectedColumns.keys()].map((table) => tableConfig(table).name)).toEqual([
      'budget_accounts',
      'budget_rule_revisions',
      'budget_reservations',
      'budget_reservation_allocations',
      'budget_reservation_transitions',
      'budget_usage_ledger',
      'budget_cost_event_outbox',
    ]);

    for (const [table, expected] of expectedColumns) {
      expect(names(tableConfig(table).columns), tableConfig(table).name).toEqual(expected);
      expectType(table, 'builder_id', 'uuid');
    }
  });

  it('mirrors SQL nullability exactly', () => {
    const nullableColumns = new Map<PgTable, Set<string>>([
      [budgetAccounts, new Set(['subject_customer_id'])],
      [budgetRuleRevisions, new Set(['target_customer_id', 'retired_at', 'retirement_reason'])],
      [
        budgetReservations,
        new Set([
          'reservation_id',
          'parent_span_id',
          'step_name',
          'provider',
          'model',
          'estimated_input_tokens',
          'max_output_tokens',
          'cost_source_slug',
          'tool_name',
          'metric',
          'maximum_value',
          'decision_reason',
          'would_have_denied',
          'state',
          'pricing_snapshot',
          'pricing_snapshot_hash',
          'requested_usd',
          'remaining_usd',
          'deciding_account_id',
          'expires_at',
          'reserved_at',
          'refused_at',
          'committed_at',
          'released_at',
          'unresolved_at',
          'unresolved_reason',
        ]),
      ],
      [budgetReservationAllocations, new Set()],
      [
        budgetReservationTransitions,
        new Set(['extension_id', 'release_reason', 'extend_by_seconds']),
      ],
      [
        budgetUsageLedger,
        new Set([
          'parent_span_id',
          'step_name',
          'provider',
          'model',
          'actual_input_tokens',
          'actual_output_tokens',
          'cost_source_slug',
          'tool_name',
          'metric',
          'actual_value',
          'pricing_snapshot',
          'usage_snapshot',
          'metadata',
          'details_purged_at',
        ]),
      ],
      [
        budgetCostEventOutbox,
        new Set([
          'payload',
          'locked_at',
          'lock_expires_at',
          'lock_owner',
          'last_attempt_at',
          'projected_at',
          'projection_verified_at',
          'payload_purged_at',
          'last_error_code',
          'last_error_message',
        ]),
      ],
    ]);

    for (const [table, nullable] of nullableColumns) {
      for (const column of tableConfig(table).columns) {
        expect(column.notNull, `${tableConfig(table).name}.${column.name}`).toBe(
          !nullable.has(column.name),
        );
      }
    }
  });

  it('uses tenant-first composite primary and foreign keys', () => {
    expect(
      [...expectedColumns.keys()].map((table) => tableConfig(table).primaryKeys[0]?.getName()),
    ).toEqual([
      'budget_accounts_pk',
      'budget_rule_revisions_pk',
      'budget_reservations_pk',
      'budget_reservation_allocations_pk',
      'budget_reservation_transitions_pk',
      'budget_usage_ledger_pk',
      'budget_cost_event_outbox_pk',
    ]);
    expect(tableConfig(budgetAccounts).primaryKeys.map((key) => names(key.columns))).toEqual([
      ['builder_id', 'id'],
    ]);
    expect(tableConfig(budgetRuleRevisions).primaryKeys.map((key) => names(key.columns))).toEqual([
      ['builder_id', 'id'],
    ]);
    expect(tableConfig(budgetReservations).primaryKeys.map((key) => names(key.columns))).toEqual([
      ['builder_id', 'decision_id'],
    ]);
    for (const table of [
      budgetReservationAllocations,
      budgetReservationTransitions,
      budgetUsageLedger,
      budgetCostEventOutbox,
    ]) {
      expect(tableConfig(table).primaryKeys.map((key) => names(key.columns))).toEqual([
        ['builder_id', 'id'],
      ]);
    }

    expect(
      [...expectedColumns.keys()].map((table) => tableConfig(table).foreignKeys.length),
    ).toEqual([2, 1, 3, 3, 1, 1, 1]);
    expect(foreignKeyShape(budgetAccounts, 'budget_accounts_builder_id_builders_id_fk')).toEqual({
      local: ['builder_id'],
      foreignTable: 'builders',
      foreign: ['id'],
      onDelete: 'restrict',
    });
    expect(foreignKeyShape(budgetAccounts, 'budget_accounts_initial_rule_revision_fk')).toEqual({
      local: ['builder_id', 'initial_rule_revision_id', 'rule_key'],
      foreignTable: 'budget_rule_revisions',
      foreign: ['builder_id', 'id', 'rule_key'],
      onDelete: 'restrict',
    });
    expect(
      foreignKeyShape(budgetRuleRevisions, 'budget_rule_revisions_builder_id_builders_id_fk'),
    ).toEqual({
      local: ['builder_id'],
      foreignTable: 'builders',
      foreign: ['id'],
      onDelete: 'restrict',
    });
    expect(
      foreignKeyShape(budgetReservations, 'budget_reservations_builder_id_builders_id_fk'),
    ).toEqual({
      local: ['builder_id'],
      foreignTable: 'builders',
      foreign: ['id'],
      onDelete: 'restrict',
    });
    expect(foreignKeyShape(budgetReservations, 'budget_reservations_deciding_account_fk')).toEqual({
      local: ['builder_id', 'deciding_account_id'],
      foreignTable: 'budget_accounts',
      foreign: ['builder_id', 'id'],
      onDelete: 'restrict',
    });
    expect(
      foreignKeyShape(budgetReservations, 'budget_reservations_deciding_allocation_fk'),
    ).toEqual({
      local: ['builder_id', 'decision_id', 'deciding_account_id'],
      foreignTable: 'budget_reservation_allocations',
      foreign: ['builder_id', 'reservation_decision_id', 'account_id'],
      onDelete: 'no action',
    });

    expect(
      foreignKeyShape(
        budgetReservationAllocations,
        'budget_reservation_allocations_reservation_fk',
      ),
    ).toEqual({
      local: ['builder_id', 'reservation_decision_id'],
      foreignTable: 'budget_reservations',
      foreign: ['builder_id', 'decision_id'],
      onDelete: 'cascade',
    });
    expect(
      foreignKeyShape(budgetReservationAllocations, 'budget_reservation_allocations_account_fk'),
    ).toEqual({
      local: ['builder_id', 'account_id', 'rule_key'],
      foreignTable: 'budget_accounts',
      foreign: ['builder_id', 'id', 'rule_key'],
      onDelete: 'restrict',
    });
    expect(
      foreignKeyShape(
        budgetReservationAllocations,
        'budget_reservation_allocations_rule_revision_fk',
      ),
    ).toEqual({
      local: ['builder_id', 'rule_revision_id', 'rule_key'],
      foreignTable: 'budget_rule_revisions',
      foreign: ['builder_id', 'id', 'rule_key'],
      onDelete: 'restrict',
    });
    expect(
      foreignKeyShape(
        budgetReservationTransitions,
        'budget_reservation_transitions_reservation_fk',
      ),
    ).toEqual({
      local: ['builder_id', 'reservation_decision_id'],
      foreignTable: 'budget_reservations',
      foreign: ['builder_id', 'decision_id'],
      onDelete: 'cascade',
    });
    expect(foreignKeyShape(budgetUsageLedger, 'budget_usage_ledger_reservation_fk')).toEqual({
      local: ['builder_id', 'reservation_decision_id', 'operation_id'],
      foreignTable: 'budget_reservations',
      foreign: ['builder_id', 'decision_id', 'operation_id'],
      onDelete: 'restrict',
    });
    expect(foreignKeyShape(budgetCostEventOutbox, 'budget_cost_event_outbox_usage_fk')).toEqual({
      local: ['builder_id', 'usage_ledger_id', 'cost_event_id'],
      foreignTable: 'budget_usage_ledger',
      foreign: ['builder_id', 'id', 'cost_event_id'],
      onDelete: 'restrict',
    });

    for (const table of expectedColumns.keys()) {
      for (const key of tableConfig(table).foreignKeys) {
        const reference = key.reference();
        if (tableConfig(reference.foreignTable).name === 'builders') continue;
        expect(reference.columns[0]?.name, key.getName()).toBe('builder_id');
        expect(reference.foreignColumns[0]?.name, key.getName()).toBe('builder_id');
      }
    }
  });

  it('pins exact fixed-point, hash, JSON, and safe bigint storage types', () => {
    const numericColumns = new Map<PgTable, string[]>([
      [budgetAccounts, ['limit_usd', 'opening_committed_usd', 'reserved_usd', 'unresolved_usd']],
      [budgetRuleRevisions, ['limit_usd']],
      [
        budgetReservations,
        ['maximum_value', 'requested_usd', 'reserved_usd', 'released_usd', 'remaining_usd'],
      ],
      [
        budgetReservationAllocations,
        [
          'committed_before_usd',
          'reserved_before_usd',
          'unresolved_before_usd',
          'requested_usd',
          'projected_usd',
          'limit_usd',
          'remaining_usd',
          'authorized_usd',
          'released_usd',
          'unresolved_usd',
        ],
      ],
      [budgetUsageLedger, ['actual_value']],
    ]);
    for (const [table, columns] of numericColumns) {
      for (const column of columns) expectType(table, column, 'numeric(38, 18)');
    }
    for (const [table, columns] of [
      [budgetReservations, ['actual_usd', 'overage_usd']],
      [budgetReservationAllocations, ['actual_usd', 'overage_usd']],
      [budgetUsageLedger, ['actual_cost_usd']],
    ] as const) {
      for (const column of columns) expectType(table, column, 'numeric(44, 18)');
    }
    expectType(budgetAccounts, 'committed_usd', 'numeric');

    const hashColumns = new Map<PgTable, string[]>([
      [budgetAccounts, ['initial_rule_snapshot_hash']],
      [budgetRuleRevisions, ['config_snapshot_hash']],
      [budgetReservations, ['request_hash', 'pricing_snapshot_hash', 'rule_set_hash']],
      [budgetReservationAllocations, ['rule_snapshot_hash']],
      [budgetReservationTransitions, ['request_hash']],
      [budgetUsageLedger, ['pricing_snapshot_hash', 'usage_snapshot_hash']],
      [budgetCostEventOutbox, ['payload_hash']],
    ]);
    for (const [table, columns] of hashColumns) {
      for (const column of columns) expectType(table, column, 'char(64)');
    }

    const bigintColumns = new Map<PgTable, string[]>([
      [budgetAccounts, ['version']],
      [budgetRuleRevisions, ['revision', 'authority_order']],
      [
        budgetReservations,
        [
          'estimated_input_tokens',
          'max_output_tokens',
          'authorization_transaction_id',
          'state_version',
        ],
      ],
      [budgetReservationAllocations, ['account_version_before']],
      [budgetReservationTransitions, ['from_state_version', 'to_state_version']],
      [budgetUsageLedger, ['actual_input_tokens', 'actual_output_tokens', 'latency_ms']],
    ]);
    for (const [table, columns] of bigintColumns) {
      for (const column of columns) expectType(table, column, 'bigint');
    }
    for (const [table, columns] of [
      [budgetAccounts, ['version']],
      [budgetRuleRevisions, ['revision', 'authority_order']],
      [budgetReservations, ['authorization_transaction_id', 'state_version']],
      [budgetReservationAllocations, ['account_version_before']],
      [budgetReservationTransitions, ['from_state_version', 'to_state_version']],
    ] as const) {
      for (const column of columns) expect(dataType(table, column)).toBe('bigint');
    }
    for (const [table, columns] of [
      [budgetReservations, ['estimated_input_tokens', 'max_output_tokens']],
      [budgetUsageLedger, ['actual_input_tokens', 'actual_output_tokens', 'latency_ms']],
    ] as const) {
      for (const column of columns) expect(dataType(table, column)).toBe('number');
    }

    const jsonColumns = new Map<PgTable, string[]>([
      [budgetAccounts, ['initial_rule_snapshot']],
      [budgetRuleRevisions, ['config_snapshot']],
      [budgetReservations, ['request_snapshot', 'pricing_snapshot', 'reserve_response_snapshot']],
      [budgetReservationAllocations, ['rule_snapshot']],
      [budgetReservationTransitions, ['request_snapshot', 'response_snapshot']],
      [budgetUsageLedger, ['pricing_snapshot', 'usage_snapshot', 'metadata']],
      [budgetCostEventOutbox, ['payload']],
    ]);
    for (const [table, columns] of jsonColumns) {
      for (const column of columns) expectType(table, column, 'jsonb');
    }

    const remainingTypes = new Map<PgTable, Record<string, string>>([
      [
        budgetAccounts,
        {
          builder_id: 'uuid',
          id: 'uuid',
          rule_key: 'uuid',
          enforcement: 'varchar(20)',
          scope: 'varchar(20)',
          subject_customer_id: 'varchar(255)',
          period: 'varchar(20)',
          period_start: 'timestamp with time zone',
          period_end: 'timestamp with time zone',
          initial_rule_revision_id: 'uuid',
          created_at: 'timestamp with time zone',
          updated_at: 'timestamp with time zone',
        },
      ],
      [
        budgetRuleRevisions,
        {
          builder_id: 'uuid',
          id: 'uuid',
          rule_key: 'uuid',
          scope: 'varchar(20)',
          target_customer_id: 'varchar(255)',
          period: 'varchar(20)',
          enforcement: 'varchar(20)',
          active_from: 'timestamp with time zone',
          retired_at: 'timestamp with time zone',
          retirement_reason: 'varchar(20)',
          created_at: 'timestamp with time zone',
        },
      ],
      [
        budgetReservations,
        {
          builder_id: 'uuid',
          decision_id: 'uuid',
          reservation_id: 'uuid',
          operation_id: 'uuid',
          schema_version: 'varchar(10)',
          mode: 'varchar(10)',
          kind: 'varchar(10)',
          customer_id: 'varchar(255)',
          trace_id: 'uuid',
          span_id: 'uuid',
          parent_span_id: 'uuid',
          step_name: 'varchar(200)',
          framework: 'varchar(40)',
          reservation_ttl_seconds: 'integer',
          provider: 'varchar(255)',
          model: 'varchar(255)',
          cost_source_slug: 'varchar(100)',
          tool_name: 'varchar(200)',
          metric: 'varchar(100)',
          decision: 'varchar(20)',
          decision_reason: 'varchar(80)',
          would_have_denied: 'boolean',
          state: 'varchar(20)',
          deciding_account_id: 'uuid',
          rule_revision_ids: 'uuid[]',
          expires_at: 'timestamp with time zone',
          reserved_at: 'timestamp with time zone',
          refused_at: 'timestamp with time zone',
          committed_at: 'timestamp with time zone',
          released_at: 'timestamp with time zone',
          unresolved_at: 'timestamp with time zone',
          unresolved_reason: 'varchar(80)',
          created_at: 'timestamp with time zone',
          updated_at: 'timestamp with time zone',
        },
      ],
      [
        budgetReservationAllocations,
        {
          builder_id: 'uuid',
          id: 'uuid',
          reservation_decision_id: 'uuid',
          account_id: 'uuid',
          rule_key: 'uuid',
          rule_revision_id: 'uuid',
          enforcement: 'varchar(20)',
          evaluation_order: 'integer',
          is_deciding: 'boolean',
          held_at_reserve: 'boolean',
          status: 'varchar(30)',
          created_at: 'timestamp with time zone',
          updated_at: 'timestamp with time zone',
        },
      ],
      [
        budgetReservationTransitions,
        {
          builder_id: 'uuid',
          id: 'uuid',
          reservation_decision_id: 'uuid',
          type: 'varchar(30)',
          extension_id: 'uuid',
          release_reason: 'varchar(50)',
          from_state: 'varchar(20)',
          to_state: 'varchar(20)',
          from_expires_at: 'timestamp with time zone',
          to_expires_at: 'timestamp with time zone',
          extend_by_seconds: 'integer',
          occurred_at: 'timestamp with time zone',
        },
      ],
      [
        budgetUsageLedger,
        {
          builder_id: 'uuid',
          id: 'uuid',
          reservation_decision_id: 'uuid',
          operation_id: 'uuid',
          cost_event_id: 'uuid',
          customer_id: 'varchar(255)',
          trace_id: 'uuid',
          span_id: 'uuid',
          parent_span_id: 'uuid',
          step_name: 'varchar(200)',
          framework: 'varchar(40)',
          sdk_version: 'varchar(50)',
          sdk_language: 'varchar(20)',
          kind: 'varchar(10)',
          provider: 'varchar(255)',
          model: 'varchar(255)',
          cost_source_slug: 'varchar(100)',
          tool_name: 'varchar(200)',
          metric: 'varchar(100)',
          status: 'varchar(20)',
          stream_aborted: 'boolean',
          cost_source: 'varchar(20)',
          instrumentation_tier: 'varchar(20)',
          is_demo: 'boolean',
          retention_days: 'integer',
          billing_retention_days: 'integer',
          committed_at: 'timestamp with time zone',
          retain_until: 'timestamp with time zone',
          details_purged_at: 'timestamp with time zone',
          created_at: 'timestamp with time zone',
        },
      ],
      [
        budgetCostEventOutbox,
        {
          builder_id: 'uuid',
          id: 'uuid',
          usage_ledger_id: 'uuid',
          cost_event_id: 'uuid',
          payload_schema_version: 'varchar(10)',
          status: 'varchar(20)',
          attempts: 'integer',
          available_at: 'timestamp with time zone',
          locked_at: 'timestamp with time zone',
          lock_expires_at: 'timestamp with time zone',
          lock_owner: 'varchar(100)',
          last_attempt_at: 'timestamp with time zone',
          projected_at: 'timestamp with time zone',
          projection_verified_at: 'timestamp with time zone',
          payload_purged_at: 'timestamp with time zone',
          last_error_code: 'varchar(80)',
          last_error_message: 'varchar(1000)',
          created_at: 'timestamp with time zone',
          updated_at: 'timestamp with time zone',
        },
      ],
    ]);
    for (const [table, columns] of remainingTypes) {
      for (const [column, sqlType] of Object.entries(columns)) {
        expectType(table, column, sqlType);
      }
    }
  });

  it('mirrors migration defaults without introducing client-side values', () => {
    for (const [table, idColumn] of [
      [budgetAccounts, 'id'],
      [budgetRuleRevisions, 'id'],
      [budgetReservations, 'decision_id'],
      [budgetReservationAllocations, 'id'],
      [budgetReservationTransitions, 'id'],
      [budgetUsageLedger, 'id'],
      [budgetCostEventOutbox, 'id'],
    ] as const) {
      expect(defaultValue(table, idColumn)).toBe('gen_random_uuid()');
    }

    for (const table of [budgetAccounts, budgetReservations, budgetReservationAllocations]) {
      for (const column of ['created_at', 'updated_at']) {
        expect(defaultValue(table, column)).toBe('now()');
      }
    }
    for (const column of ['active_from', 'created_at']) {
      expect(defaultValue(budgetRuleRevisions, column)).toBe('now()');
    }
    expect(defaultValue(budgetRuleRevisions, 'authority_order')).toBeUndefined();
    expect(defaultValue(budgetReservationTransitions, 'occurred_at')).toBe('statement_timestamp()');
    expect(defaultValue(budgetUsageLedger, 'created_at')).toBe('statement_timestamp()');
    for (const column of ['available_at', 'created_at', 'updated_at']) {
      expect(defaultValue(budgetCostEventOutbox, column)).toBe('now()');
    }

    for (const column of ['committed_usd', 'reserved_usd', 'unresolved_usd']) {
      expect(defaultValue(budgetAccounts, column)).toBe('0');
    }
    expect(defaultValue(budgetAccounts, 'opening_committed_usd')).toBeUndefined();
    for (const column of ['reserved_usd', 'actual_usd', 'released_usd', 'overage_usd']) {
      expect(defaultValue(budgetReservations, column)).toBe('0');
    }
    for (const column of [
      'authorized_usd',
      'actual_usd',
      'released_usd',
      'unresolved_usd',
      'overage_usd',
    ]) {
      expect(defaultValue(budgetReservationAllocations, column)).toBe('0');
    }

    expect(defaultValue(budgetAccounts, 'version')).toBe(0n);
    expect(defaultValue(budgetReservations, 'rule_revision_ids')).toBe('ARRAY[]::UUID[]');
    expect(defaultValue(budgetReservations, 'rule_set_hash')).toBe("repeat('0', 64)");
    expect(defaultValue(budgetReservations, 'authorization_transaction_id')).toBe(0n);
    expect(defaultValue(budgetReservations, 'state_version')).toBe(0n);
    expect(defaultValue(budgetReservations, 'framework')).toBe('none');
    expect(defaultValue(budgetReservationAllocations, 'is_deciding')).toBe(false);
    expect(defaultValue(budgetUsageLedger, 'framework')).toBe('none');
    expect(defaultValue(budgetUsageLedger, 'sdk_version')).toBe('unknown');
    expect(defaultValue(budgetUsageLedger, 'sdk_language')).toBe('unknown');
    expect(defaultValue(budgetUsageLedger, 'is_demo')).toBe(false);
    expect(defaultValue(budgetUsageLedger, 'metadata')).toEqual({});
    expect(defaultValue(budgetCostEventOutbox, 'status')).toBe('pending');
    expect(defaultValue(budgetCostEventOutbox, 'attempts')).toBe(0);
  });

  it('retains one immutable account identity including pooled NULL subjects', () => {
    const identity = tableConfig(budgetAccounts).uniqueConstraints.find(
      (constraint) => constraint.getName() === 'budget_accounts_natural_identity_uk',
    );
    expect(identity).toBeDefined();
    expect(names(identity!.columns)).toEqual([
      'builder_id',
      'rule_key',
      'scope',
      'subject_customer_id',
      'period',
      'period_start',
    ]);
    expect(identity!.nullsNotDistinct).toBe(true);
    expect(checkSql(budgetAccounts, 'budget_accounts_customer_scope_ck')).toContain(
      'subject_customer_id',
    );
  });

  it('pins every SQL UNIQUE identity, including NND transition idempotency', () => {
    expect(uniqueShapes(budgetAccounts)).toEqual([
      {
        name: 'budget_accounts_rule_identity_uk',
        columns: ['builder_id', 'id', 'rule_key'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_accounts_natural_identity_uk',
        columns: [
          'builder_id',
          'rule_key',
          'scope',
          'subject_customer_id',
          'period',
          'period_start',
        ],
        nullsNotDistinct: true,
      },
    ]);
    expect(uniqueShapes(budgetRuleRevisions)).toEqual([
      {
        name: 'budget_rule_revisions_rule_revision_uk',
        columns: ['builder_id', 'rule_key', 'revision'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_rule_revisions_authority_order_uk',
        columns: ['authority_order'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_rule_revisions_allocation_identity_uk',
        columns: ['builder_id', 'id', 'rule_key'],
        nullsNotDistinct: false,
      },
    ]);
    expect(uniqueShapes(budgetReservations)).toEqual([
      {
        name: 'budget_reservations_operation_uk',
        columns: ['builder_id', 'operation_id'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_reservations_usage_parent_uk',
        columns: ['builder_id', 'decision_id', 'operation_id'],
        nullsNotDistinct: false,
      },
    ]);
    expect(uniqueShapes(budgetReservationAllocations)).toEqual([
      {
        name: 'budget_reservation_allocations_account_uk',
        columns: ['builder_id', 'reservation_decision_id', 'account_id'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_reservation_allocations_rule_uk',
        columns: ['builder_id', 'reservation_decision_id', 'rule_key'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_reservation_allocations_order_uk',
        columns: ['builder_id', 'reservation_decision_id', 'evaluation_order'],
        nullsNotDistinct: false,
      },
    ]);
    expect(uniqueShapes(budgetReservationTransitions)).toEqual([
      {
        name: 'budget_reservation_transitions_idempotency_uk',
        columns: ['builder_id', 'reservation_decision_id', 'type', 'extension_id'],
        nullsNotDistinct: true,
      },
    ]);
    expect(uniqueShapes(budgetUsageLedger)).toEqual([
      {
        name: 'budget_usage_ledger_decision_uk',
        columns: ['builder_id', 'reservation_decision_id'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_usage_ledger_operation_uk',
        columns: ['builder_id', 'operation_id'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_usage_ledger_cost_event_uk',
        columns: ['builder_id', 'cost_event_id'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_usage_ledger_outbox_parent_uk',
        columns: ['builder_id', 'id', 'cost_event_id'],
        nullsNotDistinct: false,
      },
    ]);
    expect(uniqueShapes(budgetCostEventOutbox)).toEqual([
      {
        name: 'budget_cost_event_outbox_usage_uk',
        columns: ['builder_id', 'usage_ledger_id'],
        nullsNotDistinct: false,
      },
      {
        name: 'budget_cost_event_outbox_event_uk',
        columns: ['builder_id', 'cost_event_id'],
        nullsNotDistinct: false,
      },
    ]);
  });

  it('mirrors every SQL CHECK and its critical enum/arithmetic semantics', () => {
    expect(checkNames(budgetAccounts)).toEqual(
      [
        'budget_accounts_amounts_ck',
        'budget_accounts_customer_scope_ck',
        'budget_accounts_enforcement_ck',
        'budget_accounts_period_bounds_ck',
        'budget_accounts_period_ck',
        'budget_accounts_scope_ck',
        'budget_accounts_snapshot_ck',
        'budget_accounts_snapshot_hash_ck',
        'budget_accounts_timestamps_ck',
        'budget_accounts_version_ck',
      ].sort(),
    );
    expect(checkNames(budgetRuleRevisions)).toEqual(
      [
        'budget_rule_revisions_amount_ck',
        'budget_rule_revisions_authority_order_ck',
        'budget_rule_revisions_enforcement_ck',
        'budget_rule_revisions_lifecycle_ck',
        'budget_rule_revisions_period_ck',
        'budget_rule_revisions_revision_ck',
        'budget_rule_revisions_scope_ck',
        'budget_rule_revisions_snapshot_ck',
        'budget_rule_revisions_target_ck',
      ].sort(),
    );
    expect(checkNames(budgetReservations)).toEqual(
      [
        'budget_reservations_amounts_ck',
        'budget_reservations_authorization_tx_ck',
        'budget_reservations_customer_id_ck',
        'budget_reservations_decision_ck',
        'budget_reservations_decision_reason_ck',
        'budget_reservations_decision_state_ck',
        'budget_reservations_framework_ck',
        'budget_reservations_identifiers_ck',
        'budget_reservations_kind_ck',
        'budget_reservations_lifecycle_timestamps_ck',
        'budget_reservations_mode_ck',
        'budget_reservations_mode_decision_ck',
        'budget_reservations_pricing_snapshot_ck',
        'budget_reservations_request_hash_ck',
        'budget_reservations_request_snapshot_ck',
        'budget_reservations_response_snapshot_ck',
        'budget_reservations_rule_set_ck',
        'budget_reservations_schema_version_ck',
        'budget_reservations_settlement_math_ck',
        'budget_reservations_state_ck',
        'budget_reservations_state_version_ck',
        'budget_reservations_ttl_ck',
        'budget_reservations_usage_bounds_ck',
        'budget_reservations_usage_shape_ck',
      ].sort(),
    );
    expect(checkNames(budgetReservationAllocations)).toEqual(
      [
        'budget_reservation_allocations_amounts_ck',
        'budget_reservation_allocations_account_version_ck',
        'budget_reservation_allocations_authorization_ck',
        'budget_reservation_allocations_control_result_ck',
        'budget_reservation_allocations_deciding_ck',
        'budget_reservation_allocations_decision_math_ck',
        'budget_reservation_allocations_enforcement_ck',
        'budget_reservation_allocations_held_ck',
        'budget_reservation_allocations_order_ck',
        'budget_reservation_allocations_settlement_math_ck',
        'budget_reservation_allocations_snapshot_ck',
        'budget_reservation_allocations_status_ck',
        'budget_reservation_allocations_timestamps_ck',
      ].sort(),
    );
    expect(checkNames(budgetReservationTransitions)).toEqual(
      [
        'budget_reservation_transitions_extension_ck',
        'budget_reservation_transitions_expiry_ck',
        'budget_reservation_transitions_release_reason_ck',
        'budget_reservation_transitions_snapshot_ck',
        'budget_reservation_transitions_state_ck',
        'budget_reservation_transitions_type_ck',
        'budget_reservation_transitions_version_ck',
      ].sort(),
    );
    expect(checkNames(budgetUsageLedger)).toEqual(
      [
        'budget_usage_ledger_customer_id_ck',
        'budget_usage_ledger_framework_ck',
        'budget_usage_ledger_identifiers_ck',
        'budget_usage_ledger_kind_ck',
        'budget_usage_ledger_metadata_ck',
        'budget_usage_ledger_projection_shape_ck',
        'budget_usage_ledger_retention_ck',
        'budget_usage_ledger_sdk_identity_ck',
        'budget_usage_ledger_snapshots_ck',
        'budget_usage_ledger_status_ck',
        'budget_usage_ledger_usage_bounds_ck',
        'budget_usage_ledger_usage_shape_ck',
      ].sort(),
    );
    expect(checkNames(budgetCostEventOutbox)).toEqual(
      [
        'budget_cost_event_outbox_attempt_time_ck',
        'budget_cost_event_outbox_attempts_ck',
        'budget_cost_event_outbox_error_ck',
        'budget_cost_event_outbox_lifecycle_ck',
        'budget_cost_event_outbox_payload_ck',
        'budget_cost_event_outbox_status_ck',
      ].sort(),
    );

    const reservationFramework = checkSql(budgetReservations, 'budget_reservations_framework_ck');
    expect(reservationFramework).toContain("'openai-agents'");
    expect(reservationFramework).toContain("'pydantic-ai'");
    const decisionReason = checkSql(budgetReservations, 'budget_reservations_decision_reason_ck');
    expect(decisionReason).toContain('CASE');
    expect(decisionReason).toContain('IS NOT DISTINCT FROM');
    const decisionState = checkSql(budgetReservations, 'budget_reservations_decision_state_ck');
    expect(decisionState).toContain('CASE');
    expect(decisionState).toContain('IS NOT DISTINCT FROM');
    expect(checkSql(budgetReservations, 'budget_reservations_lifecycle_timestamps_ck')).toContain(
      'IS NOT DISTINCT FROM',
    );
    expect(checkSql(budgetReservations, 'budget_reservations_settlement_math_ck')).toContain(
      'GREATEST',
    );
    expect(checkSql(budgetAccounts, 'budget_accounts_period_bounds_ck')).toContain('date_trunc');
    expect(checkSql(budgetAccounts, 'budget_accounts_period_bounds_ck')).toContain(
      'pylva_budget_timestamp_is_wire_safe',
    );
    const accountSnapshot = checkSql(budgetAccounts, 'budget_accounts_snapshot_ck');
    expect(accountSnapshot).toContain('IS NOT DISTINCT FROM');
    expect(accountSnapshot).toContain('pylva_budget_jsonb_uuid_matches');
    expect(accountSnapshot).toContain('pylva_budget_timestamp_text');
    expect(accountSnapshot).toContain('pylva_budget_decimal_text');
    expect(accountSnapshot).toMatch(
      /jsonb_typeof\([^)]*->'schema_version'\)\s+IS NOT DISTINCT FROM 'string'/,
    );
    for (const key of [
      'schema_version',
      'rule_key',
      'scope',
      'subject_customer_id',
      'period',
      'period_start',
      'period_end',
      'enforcement',
      'limit_usd',
      'opening_committed_usd',
    ]) {
      expect(accountSnapshot).toContain(key);
    }
    const accountAmounts = checkSql(budgetAccounts, 'budget_accounts_amounts_ck');
    expect(accountAmounts).toContain("<> 'NaN'::numeric");
    expect(accountAmounts).toContain("<> 'Infinity'::numeric");
    expect(accountAmounts).toContain('opening_committed_usd');
    expect(accountAmounts).not.toContain('99999999999999999999.999999999999999999');
    expect(checkSql(budgetAccounts, 'budget_accounts_snapshot_hash_ck')).toContain(
      'pylva_budget_jsonb_sha256',
    );
    expect(checkSql(budgetAccounts, 'budget_accounts_timestamps_ck')).toContain(
      'pylva_budget_timestamp_is_wire_safe',
    );

    const revisionSnapshot = checkSql(budgetRuleRevisions, 'budget_rule_revisions_snapshot_ck');
    expect(revisionSnapshot).toContain('pylva_budget_jsonb_uuid_matches');
    expect(revisionSnapshot).toContain('pylva_budget_decimal_text');
    expect(revisionSnapshot).toContain('pylva_budget_jsonb_sha256');
    expect(revisionSnapshot).toContain('target_customer_id');
    expect(revisionSnapshot).toMatch(
      /jsonb_typeof\([^)]*->'schema_version'\)\s+IS NOT DISTINCT FROM 'string'/,
    );
    for (const key of [
      'schema_version',
      'rule_key',
      'scope',
      'target_customer_id',
      'period',
      'enforcement',
      'limit_usd',
    ]) {
      expect(revisionSnapshot).toContain(key);
    }
    expect(checkSql(budgetRuleRevisions, 'budget_rule_revisions_scope_ck')).toContain(
      "'per_customer'",
    );
    const revisionTarget = checkSql(budgetRuleRevisions, 'budget_rule_revisions_target_ck');
    expect(revisionTarget).toContain('^[A-Za-z0-9_-]{1,255}$');
    expect(revisionTarget).toContain("'pooled'");
    expect(revisionTarget).toContain('target_customer_id');
    expect(checkSql(budgetRuleRevisions, 'budget_rule_revisions_period_ck')).toContain("'month'");
    expect(checkSql(budgetRuleRevisions, 'budget_rule_revisions_revision_ck')).toContain(
      '9223372036854775806',
    );
    expect(checkSql(budgetRuleRevisions, 'budget_rule_revisions_authority_order_ck')).toContain(
      'BETWEEN 1 AND 9223372036854775806',
    );
    expect(checkSql(budgetRuleRevisions, 'budget_rule_revisions_amount_ck')).toContain(
      "<> 'NaN'::numeric",
    );
    const revisionLifecycle = checkSql(budgetRuleRevisions, 'budget_rule_revisions_lifecycle_ck');
    expect(revisionLifecycle).toContain('pylva_budget_timestamp_is_wire_safe');
    expect(revisionLifecycle).toContain("'superseded'");
    expect(revisionLifecycle).toContain("'disabled'");
    expect(revisionLifecycle).toContain("'deleted'");

    expect(checkSql(budgetReservations, 'budget_reservations_request_hash_ck')).toContain(
      'pylva_budget_jsonb_sha256',
    );
    const reservationRuleSet = checkSql(budgetReservations, 'budget_reservations_rule_set_ck');
    expect(reservationRuleSet).toContain('pylva_budget_uuid_array_is_canonical');
    expect(reservationRuleSet).toContain('pylva_budget_jsonb_sha256');
    expect(reservationRuleSet).toContain('rule_revision_ids');
    expect(checkSql(budgetReservations, 'budget_reservations_authorization_tx_ck')).toContain(
      'authorization_transaction_id" > 0',
    );
    const modeDecision = checkSql(budgetReservations, 'budget_reservations_mode_decision_ck');
    expect(modeDecision).toContain("mode\" = 'shadow'");
    expect(modeDecision).toContain("decision\" = 'bypassed'");
    const reservationIdentifiers = checkSql(
      budgetReservations,
      'budget_reservations_identifiers_ck',
    );
    expect(reservationIdentifiers).toContain('u0001');
    expect(reservationIdentifiers).toContain('u007F');
    expect(reservationIdentifiers).toContain('u0085');
    expect(reservationIdentifiers).toContain('uFEFF');
    expect(reservationIdentifiers).not.toContain('[[:cntrl:]]');
    expect(checkSql(budgetReservations, 'budget_reservations_amounts_ck')).toContain(
      "<> 'NaN'::numeric",
    );
    const reservationTimestamps = checkSql(
      budgetReservations,
      'budget_reservations_lifecycle_timestamps_ck',
    );
    expect(reservationTimestamps).toContain('pylva_budget_timestamp_is_wire_safe');
    expect(reservationTimestamps).toContain("unresolved_reason\" = 'lease_expired'");
    expect(reservationTimestamps).toContain('updated_at" >=');
    expect(reservationTimestamps).toContain('committed_at" >=');

    const allocationStatus = checkSql(
      budgetReservationAllocations,
      'budget_reservation_allocations_status_ck',
    );
    expect(allocationStatus).toContain("'refused'");
    expect(allocationStatus).toContain("'shadow'");
    expect(allocationStatus).toContain("'not_held'");
    expect(allocationStatus).not.toContain("'allowed'");
    const allocationAmounts = checkSql(
      budgetReservationAllocations,
      'budget_reservation_allocations_amounts_ck',
    );
    for (const column of [
      'authorized_usd',
      'actual_usd',
      'released_usd',
      'unresolved_usd',
      'overage_usd',
    ]) {
      expect(allocationAmounts).toContain(`"${column}" >= 0`);
    }
    expect(
      checkSql(budgetReservationAllocations, 'budget_reservation_allocations_control_result_ck'),
    ).toContain('projected_usd');
    expect(
      checkSql(budgetReservationAllocations, 'budget_reservation_allocations_held_ck'),
    ).toContain('held_at_reserve');
    expect(
      checkSql(budgetReservationAllocations, 'budget_reservation_allocations_account_version_ck'),
    ).toContain('9223372036854775806');
    expect(
      checkSql(budgetReservationAllocations, 'budget_reservation_allocations_decision_math_ck'),
    ).toContain("<> 'NaN'::numeric");
    expect(
      checkSql(budgetReservationAllocations, 'budget_reservation_allocations_timestamps_ck'),
    ).toContain('pylva_budget_timestamp_is_wire_safe');

    expect(
      checkSql(budgetReservationTransitions, 'budget_reservation_transitions_release_reason_ck'),
    ).toContain('provider_confirmed_uncharged');
    expect(
      checkSql(budgetReservationTransitions, 'budget_reservation_transitions_version_ck'),
    ).toContain('to_state_version');
    const transitionExpiry = checkSql(
      budgetReservationTransitions,
      'budget_reservation_transitions_expiry_ck',
    );
    expect(transitionExpiry).toContain('make_interval');
    expect(transitionExpiry).toContain('occurred_at');
    expect(transitionExpiry).toContain('pylva_budget_timestamp_is_wire_safe');

    expect(checkSql(budgetUsageLedger, 'budget_usage_ledger_framework_ck')).toContain(
      "'openai-agents'",
    );
    expect(checkSql(budgetUsageLedger, 'budget_usage_ledger_metadata_ck')).toContain(
      'provider_request_id',
    );
    const usageRetention = checkSql(budgetUsageLedger, 'budget_usage_ledger_retention_ck');
    expect(usageRetention).toContain('BETWEEN 1 AND 18250');
    expect(usageRetention).toContain('pylva_budget_timestamp_is_wire_safe');
    expect(usageRetention).toContain('created_at" >=');
    expect(checkSql(budgetUsageLedger, 'budget_usage_ledger_status_ck')).not.toContain(
      'stream_aborted',
    );
    const projectionShape = checkSql(budgetUsageLedger, 'budget_usage_ledger_projection_shape_ck');
    expect(projectionShape).toContain("kind\" = 'llm'");
    expect(projectionShape).toContain("kind\" = 'tool'");
    const usageSnapshots = checkSql(budgetUsageLedger, 'budget_usage_ledger_snapshots_ck');
    expect(usageSnapshots).toContain('details_purged_at');
    expect(usageSnapshots).toContain('pylva_budget_jsonb_sha256');
    expect(usageSnapshots).toContain('pylva_budget_timestamp_is_wire_safe');
    expect(checkSql(budgetUsageLedger, 'budget_usage_ledger_metadata_ck')).toContain(
      'details_purged_at',
    );
    const outboxPayload = checkSql(budgetCostEventOutbox, 'budget_cost_event_outbox_payload_ck');
    expect(outboxPayload).toContain("payload_schema_version\" = '1.6'");
    expect(outboxPayload).toContain('projection_verified_at');
    expect(outboxPayload).toContain('payload_purged_at');
    expect(outboxPayload).toContain('builder_id');
    expect(outboxPayload).toContain('IS NOT DISTINCT FROM');
    expect(outboxPayload).toContain('pylva_budget_timestamp_is_wire_safe');
    const outboxLifecycle = checkSql(
      budgetCostEventOutbox,
      'budget_cost_event_outbox_lifecycle_ck',
    );
    expect(outboxLifecycle).toContain('lock_expires_at');
    expect(outboxLifecycle).toContain("INTERVAL '5 minutes'");
    expect(outboxLifecycle).toContain('pylva_budget_timestamp_is_wire_safe');
    expect(outboxLifecycle).toContain('u007F');
    expect(outboxLifecycle).toContain('uFEFF');
    expect(checkSql(budgetCostEventOutbox, 'budget_cost_event_outbox_attempts_ck')).toContain(
      '2147483646',
    );
    expect(checkSql(budgetCostEventOutbox, 'budget_cost_event_outbox_attempt_time_ck')).toContain(
      'last_attempt_at',
    );
  });

  it('models idempotency and work-claim indexes, including one terminal transition', () => {
    const expectedIndexNames = new Map<PgTable, string[]>([
      [budgetAccounts, ['idx_budget_accounts_builder_period', 'idx_budget_accounts_builder_rule']],
      [
        budgetRuleRevisions,
        [
          'budget_rule_revisions_one_active_uk',
          'idx_budget_rule_revisions_builder_rule',
          'idx_budget_rule_revisions_active_scope',
        ],
      ],
      [
        budgetReservations,
        [
          'budget_reservations_reservation_uk',
          'idx_budget_reservations_builder_customer_created',
          'idx_budget_reservations_expiry',
          'idx_budget_reservations_expiry_discovery',
          'idx_budget_reservations_builder_state_updated',
          'idx_budget_reservations_builder_authorization_tx',
        ],
      ],
      [
        budgetReservationAllocations,
        [
          'idx_budget_reservation_allocations_account',
          'idx_budget_reservation_allocations_decision_status',
          'budget_reservation_allocations_observed_version_uk',
          'budget_reservation_allocations_deciding_uk',
        ],
      ],
      [
        budgetReservationTransitions,
        [
          'budget_reservation_transitions_terminal_uk',
          'budget_reservation_transitions_from_version_uk',
          'budget_reservation_transitions_to_version_uk',
          'idx_budget_reservation_transitions_decision_occurred',
        ],
      ],
      [
        budgetUsageLedger,
        [
          'idx_budget_usage_ledger_builder_committed',
          'idx_budget_usage_ledger_retain_until',
          'idx_budget_usage_ledger_purge_ready',
          'idx_budget_usage_ledger_trace',
        ],
      ],
      [
        budgetCostEventOutbox,
        [
          'idx_budget_cost_event_outbox_pending',
          'idx_budget_cost_event_outbox_expired_lease',
          'idx_budget_cost_event_outbox_projected_unverified',
          'idx_budget_cost_event_outbox_builder_status',
        ],
      ],
    ]);
    for (const [table, expected] of expectedIndexNames) {
      expect(
        tableConfig(table).indexes.map((candidate) => candidate.config.name),
        tableConfig(table).name,
      ).toEqual(expected);
    }

    expect(indexShape(budgetAccounts, 'idx_budget_accounts_builder_period')).toEqual({
      columns: [
        'builder_id',
        'period_start',
        'period_end',
        'rule_key',
        'scope',
        'subject_customer_id',
        'id',
      ],
      unique: false,
      where: undefined,
    });
    expect(indexShape(budgetAccounts, 'idx_budget_accounts_builder_rule')).toEqual({
      columns: ['builder_id', 'rule_key'],
      unique: false,
      where: undefined,
    });

    expect(indexShape(budgetRuleRevisions, 'budget_rule_revisions_one_active_uk')).toEqual({
      columns: ['builder_id', 'rule_key'],
      unique: true,
      where: '"budget_rule_revisions"."retired_at" IS NULL',
    });
    expect(indexShape(budgetRuleRevisions, 'idx_budget_rule_revisions_builder_rule')).toEqual({
      columns: ['builder_id', 'rule_key', 'revision:desc'],
      unique: false,
      where: undefined,
    });
    expect(indexShape(budgetRuleRevisions, 'idx_budget_rule_revisions_active_scope')).toEqual({
      columns: ['builder_id', 'scope', 'target_customer_id', 'period', 'rule_key', 'id'],
      unique: false,
      where: '"budget_rule_revisions"."retired_at" IS NULL',
    });

    expect(indexShape(budgetReservations, 'budget_reservations_reservation_uk')).toEqual({
      columns: ['builder_id', 'reservation_id'],
      unique: true,
      where: '"budget_reservations"."reservation_id" IS NOT NULL',
    });
    expect(
      indexShape(budgetReservations, 'idx_budget_reservations_builder_customer_created'),
    ).toEqual({
      columns: ['builder_id', 'customer_id', 'created_at:desc:nulls-first'],
      unique: false,
      where: undefined,
    });
    expect(indexShape(budgetReservations, 'idx_budget_reservations_expiry')).toEqual({
      columns: ['expires_at', 'builder_id', 'decision_id'],
      unique: false,
      where: '"budget_reservations"."state" = \'reserved\'',
    });
    expect(indexShape(budgetReservations, 'idx_budget_reservations_expiry_discovery')).toEqual({
      columns: ['builder_id', 'expires_at', 'decision_id'],
      unique: false,
      where:
        '"budget_reservations"."state" = \'reserved\' AND "budget_reservations"."decision" = \'reserved\'',
    });
    expect(indexShape(budgetReservations, 'idx_budget_reservations_builder_state_updated')).toEqual(
      {
        columns: ['builder_id', 'state', 'updated_at:desc:nulls-first'],
        unique: false,
        where: undefined,
      },
    );
    expect(
      indexShape(budgetReservations, 'idx_budget_reservations_builder_authorization_tx'),
    ).toEqual({
      columns: ['builder_id', 'authorization_transaction_id'],
      unique: false,
      where: undefined,
    });

    expect(
      indexShape(budgetReservationAllocations, 'idx_budget_reservation_allocations_account'),
    ).toEqual({
      columns: ['builder_id', 'account_id', 'status'],
      unique: false,
      where: undefined,
    });
    expect(
      indexShape(
        budgetReservationAllocations,
        'idx_budget_reservation_allocations_decision_status',
      ),
    ).toEqual({
      columns: ['builder_id', 'reservation_decision_id', 'status'],
      unique: false,
      where: undefined,
    });
    expect(
      indexShape(
        budgetReservationAllocations,
        'budget_reservation_allocations_observed_version_uk',
      ),
    ).toEqual({
      columns: ['builder_id', 'account_id', 'account_version_before'],
      unique: true,
      where: '"budget_reservation_allocations"."held_at_reserve"',
    });
    expect(
      indexShape(budgetReservationAllocations, 'budget_reservation_allocations_deciding_uk'),
    ).toEqual({
      columns: ['builder_id', 'reservation_decision_id'],
      unique: true,
      where: '"budget_reservation_allocations"."is_deciding"',
    });

    expect(
      indexShape(budgetReservationTransitions, 'budget_reservation_transitions_terminal_uk'),
    ).toEqual({
      columns: ['builder_id', 'reservation_decision_id'],
      unique: true,
      where: '"budget_reservation_transitions"."type" IN (\'commit\', \'release\')',
    });
    expect(
      indexShape(budgetReservationTransitions, 'budget_reservation_transitions_from_version_uk'),
    ).toEqual({
      columns: ['builder_id', 'reservation_decision_id', 'from_state_version'],
      unique: true,
      where: undefined,
    });
    expect(
      indexShape(budgetReservationTransitions, 'budget_reservation_transitions_to_version_uk'),
    ).toEqual({
      columns: ['builder_id', 'reservation_decision_id', 'to_state_version'],
      unique: true,
      where: undefined,
    });
    expect(
      indexShape(
        budgetReservationTransitions,
        'idx_budget_reservation_transitions_decision_occurred',
      ),
    ).toEqual({
      columns: ['builder_id', 'reservation_decision_id', 'occurred_at', 'id'],
      unique: false,
      where: undefined,
    });

    expect(indexShape(budgetUsageLedger, 'idx_budget_usage_ledger_builder_committed')).toEqual({
      columns: ['builder_id', 'committed_at:desc:nulls-first', 'id'],
      unique: false,
      where: undefined,
    });
    expect(indexShape(budgetUsageLedger, 'idx_budget_usage_ledger_retain_until')).toEqual({
      columns: ['retain_until', 'builder_id', 'id'],
      unique: false,
      where: undefined,
    });
    expect(indexShape(budgetUsageLedger, 'idx_budget_usage_ledger_purge_ready')).toEqual({
      columns: ['builder_id', 'retain_until', 'id'],
      unique: false,
      where: '"budget_usage_ledger"."details_purged_at" IS NULL',
    });
    expect(indexShape(budgetUsageLedger, 'idx_budget_usage_ledger_trace')).toEqual({
      columns: ['builder_id', 'trace_id', 'committed_at:desc:nulls-first'],
      unique: false,
      where: undefined,
    });

    expect(indexShape(budgetCostEventOutbox, 'idx_budget_cost_event_outbox_pending')).toEqual({
      columns: ['available_at', 'created_at', 'builder_id', 'id'],
      unique: false,
      where: '"budget_cost_event_outbox"."status" = \'pending\'',
    });
    expect(indexShape(budgetCostEventOutbox, 'idx_budget_cost_event_outbox_expired_lease')).toEqual(
      {
        columns: ['lock_expires_at', 'builder_id', 'id'],
        unique: false,
        where: '"budget_cost_event_outbox"."status" = \'processing\'',
      },
    );
    expect(
      indexShape(budgetCostEventOutbox, 'idx_budget_cost_event_outbox_projected_unverified'),
    ).toEqual({
      columns: ['builder_id'],
      unique: false,
      where:
        '"budget_cost_event_outbox"."status" = \'projected\' AND "budget_cost_event_outbox"."projection_verified_at" IS NULL',
    });
    expect(
      indexShape(budgetCostEventOutbox, 'idx_budget_cost_event_outbox_builder_status'),
    ).toEqual({
      columns: ['builder_id', 'status', 'updated_at:desc:nulls-first'],
      unique: false,
      where: undefined,
    });
  });

  it('documents every physical feature that Drizzle 0.45 cannot represent', () => {
    for (const table of expectedColumns.keys()) {
      expect(tableConfig(table).enableRLS, tableConfig(table).name).toBe(false);
      expect(tableConfig(table).policies, tableConfig(table).name).toEqual([]);
    }

    const schemaSource = readFileSync(
      new URL('../../src/lib/db/schema.ts', import.meta.url),
      'utf8',
    );
    const migrationSource = readFileSync(
      new URL('../../db/migrations/050_authoritative_budget_control_ledger.sql', import.meta.url),
      'utf8',
    );
    const ledgerSchemaSource = schemaSource.slice(
      schemaSource.indexOf('// --- authoritative budget-control ledger (migration 050) ---'),
    );
    expect(ledgerSchemaSource).not.toContain('isfinite(');
    expect(ledgerSchemaSource).toContain('pylva_budget_timestamp_is_wire_safe');
    for (const trigger of [
      'budget_accounts_immutability_guard',
      'budget_rule_revisions_immutability_guard',
      'budget_rule_revisions_successor_consistency_guard',
      'budget_reservations_immutability_guard',
      'budget_reservation_allocations_insert_guard',
      'budget_reservation_allocations_immutability_guard',
      'budget_reservation_allocations_posting_guard',
      'budget_reservation_transitions_append_only_guard',
      'budget_usage_ledger_immutability_guard',
      'budget_usage_ledger_parent_consistency_guard',
      'budget_reservations_usage_consistency_guard',
      'budget_usage_ledger_retention_pair_guard',
      'budget_cost_event_outbox_retention_pair_guard',
      'budget_reservations_transition_consistency_guard',
      'budget_reservation_transitions_parent_consistency_guard',
      'budget_reservations_allocations_consistency_guard',
      'budget_reservation_allocations_parent_consistency_guard',
      'budget_accounts_postings_consistency_guard',
      'budget_reservation_allocations_postings_consistency_guard',
      'budget_cost_event_outbox_immutability_guard',
    ]) {
      expect(schemaSource).toContain(trigger);
      expect(migrationSource).toContain(trigger);
    }
    expect(schemaSource).toContain('FORCE-RLS');
    expect(schemaSource).toContain('Migration-only');
    expect(schemaSource).toContain('budget_reservations_deciding_allocation_fk');
    expect(schemaSource).toContain('INCLUDE columns');
    expect(schemaSource).toContain('NULLS NOT DISTINCT unique INDEX');
    expect(migrationSource).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migrationSource).toContain('budget_reservations_deciding_allocation_fk');
    expect(migrationSource).toContain('INCLUDE (authorized_usd, actual_usd, unresolved_usd)');
    expect(migrationSource).toContain('NULLS NOT DISTINCT');
  });
});
