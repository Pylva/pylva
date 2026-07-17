import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  budgetAccountOpeningEvidence,
  budgetAccounts,
  budgetControlCutovers,
  budgetReservationAllocations,
  budgetReservations,
  budgetRuleRevisions,
  budgetUsageLedger,
} from '../../src/lib/db/schema.js';

const migration = readFileSync(
  new URL('../../db/migrations/051_authoritative_budget_control_runtime.sql', import.meta.url),
  'utf8',
);

function config(table: PgTable) {
  return getTableConfig(table);
}

function columnType(table: PgTable, name: string): string {
  const column = config(table).columns.find((candidate) => candidate.name === name);
  expect(column, `${config(table).name}.${name}`).toBeDefined();
  return column!.getSQLType();
}

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('\n$$;', start);
  expect(end, name).toBeGreaterThan(start);
  return migration.slice(start, end + 4);
}

describe('authoritative budget-control runtime migration 051', () => {
  it('widens only post-provider actual-cost and overage evidence', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.budget_reservations\s+ALTER COLUMN actual_usd TYPE NUMERIC\(44,18\),\s+ALTER COLUMN overage_usd TYPE NUMERIC\(44,18\);/,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.budget_reservation_allocations\s+ALTER COLUMN actual_usd TYPE NUMERIC\(44,18\),\s+ALTER COLUMN overage_usd TYPE NUMERIC\(44,18\);/,
    );
    expect(migration).toMatch(
      /ALTER TABLE public\.budget_usage_ledger\s+ALTER COLUMN actual_cost_usd TYPE NUMERIC\(44,18\);/,
    );
    expect(migration).not.toMatch(
      /ALTER COLUMN (?:requested_usd|reserved_usd|released_usd|limit_usd|opening_committed_usd) TYPE/,
    );

    expect(columnType(budgetReservations, 'actual_usd')).toBe('numeric(44, 18)');
    expect(columnType(budgetReservations, 'overage_usd')).toBe('numeric(44, 18)');
    expect(columnType(budgetReservationAllocations, 'actual_usd')).toBe('numeric(44, 18)');
    expect(columnType(budgetReservationAllocations, 'overage_usd')).toBe('numeric(44, 18)');
    expect(columnType(budgetUsageLedger, 'actual_cost_usd')).toBe('numeric(44, 18)');
    expect(columnType(budgetReservations, 'requested_usd')).toBe('numeric(38, 18)');
    expect(columnType(budgetAccounts, 'opening_committed_usd')).toBe('numeric(38, 18)');
  });

  it('stores honest shadow unavailability without fabricated evaluation facts', () => {
    expect(migration).toContain("WHEN 'shadow_control_unavailable' THEN");
    expect(migration).toMatch(
      /WHEN 'shadow_control_unavailable' THEN\s+mode = 'shadow' AND would_have_denied IS NULL/,
    );
    expect(migration).toMatch(
      /decision_reason IS DISTINCT FROM 'shadow_control_unavailable'[\s\S]*?pricing_snapshot IS NULL[\s\S]*?pricing_snapshot_hash IS NULL[\s\S]*?requested_usd IS NULL[\s\S]*?remaining_usd IS NULL[\s\S]*?deciding_account_id IS NULL/,
    );
  });

  it('uses one server-owned, monotonic and irreversible readiness authority', () => {
    expect(config(budgetControlCutovers).columns.map((column) => column.name)).toEqual([
      'builder_id',
      'status',
      'mode',
      'cutover_at',
      'reconciled_through',
      'reconciliation_snapshot',
      'reconciliation_snapshot_hash',
      'ready_at',
      'ready_order',
      'created_at',
      'updated_at',
    ]);
    expect(
      config(budgetControlCutovers)
        .checks.map((check) => check.name)
        .sort(),
    ).toEqual([
      'budget_control_cutovers_lifecycle_ck',
      'budget_control_cutovers_mode_ck',
      'budget_control_cutovers_ready_order_ck',
      'budget_control_cutovers_reconciliation_ck',
      'budget_control_cutovers_status_ck',
      'budget_control_cutovers_timestamps_ck',
    ]);

    const guard = functionBody('pylva_budget_cutovers_guard');
    expect(guard).toContain('50620260714');
    expect(guard).toContain("date_trunc('milliseconds', clock_timestamp())");
    expect(guard).toContain('NEW.cutover_at := GREATEST(OLD.cutover_at, activation_boundary)');
    expect(guard).toContain("IF OLD.status = 'ready' THEN");
    expect(guard).toContain('ready budget-control cutovers are immutable and cannot be reversed');
    expect(guard).toContain(
      'next-period cutover cannot become ready before its activation boundary',
    );
    expect(guard).toContain(
      'exact backfill must reconcile through the immutable cutover watermark',
    );
    expect(guard).toContain(
      "NEW.ready_order := pg_catalog.nextval(\n    'public.pylva_budget_authority_order_seq'::REGCLASS",
    );
  });

  it('orders rule origins and readiness under the same frozen exclusive builder lock', () => {
    expect(columnType(budgetRuleRevisions, 'authority_order')).toBe('bigint');
    expect(columnType(budgetControlCutovers, 'ready_order')).toBe('bigint');
    expect(
      config(budgetRuleRevisions).columns.find((column) => column.name === 'authority_order')
        ?.hasDefault,
    ).toBe(false);
    expect(config(budgetRuleRevisions).checks.map((check) => check.name)).toContain(
      'budget_rule_revisions_authority_order_ck',
    );
    expect(config(budgetRuleRevisions).uniqueConstraints.map((key) => key.name)).toContain(
      'budget_rule_revisions_authority_order_uk',
    );

    expect(migration).toMatch(
      /CREATE SEQUENCE public\.pylva_budget_authority_order_seq[\s\S]*?MINVALUE 1[\s\S]*?MAXVALUE 9223372036854775806[\s\S]*?NO CYCLE;/,
    );
    expect(migration).toContain(
      'REVOKE ALL ON SEQUENCE public.pylva_budget_authority_order_seq FROM PUBLIC;',
    );
    expect(migration).toMatch(
      /ADD COLUMN authority_order BIGINT NOT NULL\s+DEFAULT pg_catalog\.nextval\('public\.pylva_budget_authority_order_seq'::REGCLASS\);[\s\S]*?ALTER COLUMN authority_order DROP DEFAULT/,
    );

    const guard = functionBody('pylva_budget_rule_revision_authority_order_guard');
    const lock = guard.indexOf('pg_catalog.pg_advisory_xact_lock(');
    const allocation = guard.indexOf('NEW.authority_order := pg_catalog.nextval(');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(allocation).toBeGreaterThan(lock);
    expect(guard).toContain('50620260714');
    expect(migration).toMatch(
      /CREATE TRIGGER budget_rule_revisions_authority_order_guard\s+BEFORE INSERT ON public\.budget_rule_revisions/,
    );
  });

  it('binds every evaluated reservation outcome to readiness that predates it', () => {
    const assertion = functionBody('pylva_budget_assert_reservation_readiness');
    for (const value of [
      "'reserved'",
      "'denied'",
      "'no_applicable_budget'",
      "'shadow_would_allow'",
      "'shadow_would_deny'",
    ]) {
      expect(assertion).toContain(value);
    }
    expect(assertion).not.toContain("'shadow_control_unavailable'");
    expect(assertion).not.toContain("'control_unavailable'");
    expect(assertion).toMatch(/cutover_row\.status <> 'ready'/);
    expect(assertion).toMatch(/cutover_row\.ready_at > reservation_row\.created_at/);
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER budget_reservations_readiness_consistency_guard\s+AFTER INSERT ON public\.budget_reservations\s+DEFERRABLE INITIALLY DEFERRED/,
    );
  });

  it('refuses to grandfather pre-readiness accounts or evaluated decisions', () => {
    const preflight = migration.slice(0, migration.indexOf('-- D049:'));
    expect(preflight).toContain('migration 051 requires an empty pre-roll budget_accounts table');
    expect(preflight).toContain(
      'migration 051 cannot grandfather evaluated budget decisions without typed readiness',
    );
    for (const value of [
      "'reserved'",
      "'denied'",
      "'no_applicable_budget'",
      "'shadow_would_allow'",
      "'shadow_would_deny'",
    ]) {
      expect(preflight).toContain(value);
    }
  });

  it('requires immutable canonical opening evidence for every account', () => {
    expect(config(budgetAccountOpeningEvidence).columns.map((column) => column.name)).toEqual([
      'builder_id',
      'account_id',
      'source',
      'opening_committed_usd',
      'measured_through',
      'evidence_snapshot',
      'evidence_snapshot_hash',
      'created_at',
    ]);
    expect(
      config(budgetAccountOpeningEvidence)
        .checks.map((check) => check.name)
        .sort(),
    ).toEqual([
      'budget_account_opening_evidence_amount_ck',
      'budget_account_opening_evidence_snapshot_ck',
      'budget_account_opening_evidence_source_ck',
      'budget_account_opening_evidence_timestamps_ck',
    ]);
    expect(migration).toMatch(
      /CONSTRAINT budget_account_opening_evidence_account_fk[\s\S]*?ON DELETE RESTRICT\s+DEFERRABLE INITIALLY DEFERRED/,
    );
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER budget_accounts_opening_evidence_consistency_guard[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
    );
    expect(migration).toMatch(
      /CREATE CONSTRAINT TRIGGER budget_account_opening_evidence_consistency_guard[\s\S]*?DEFERRABLE INITIALLY DEFERRED/,
    );
    const assertion = functionBody('pylva_budget_assert_account_opening_evidence');
    expect(assertion).toContain('every budget account requires exactly one opening-evidence row');
    expect(assertion).toContain('budget accounts require a ready authoritative cutover');
    expect(assertion).toContain("evidence_row.source = 'post_cutover_zero'");
    expect(assertion).toContain('INTO origin_revision_row');
    expect(assertion).toContain('AND revision = 0');
    expect(assertion).toContain('origin_revision_row.authority_order > cutover_row.ready_order');
    expect(assertion).not.toContain('initial_revision_row.active_from');
    expect(assertion).toContain("evidence_row.source = 'exact_backfill'");
    expect(assertion).toContain('account opening-evidence snapshot is not canonical');
    expect(migration).toMatch(
      /ALTER TABLE public\.budget_accounts\s+ALTER COLUMN opening_committed_usd DROP DEFAULT;/,
    );
    expect(
      config(budgetAccounts).columns.find((column) => column.name === 'opening_committed_usd')
        ?.hasDefault,
    ).toBe(false);
  });

  it('pins every 051 helper to trusted schemas and forces tenant RLS', () => {
    for (const name of [
      'pylva_budget_next_period_boundary',
      'pylva_budget_rule_revision_authority_order_guard',
      'pylva_budget_builder_next_activation_boundary',
      'pylva_budget_cutovers_guard',
      'pylva_budget_assert_reservation_readiness',
      'pylva_budget_reservation_readiness_consistency_guard',
      'pylva_budget_opening_evidence_guard',
      'pylva_budget_assert_account_opening_evidence',
      'pylva_budget_account_opening_consistency_guard',
      'pylva_budget_opening_evidence_consistency_guard',
    ]) {
      expect(functionBody(name), name).toMatch(/SET search_path = pg_catalog(?:, public)?/);
    }

    for (const table of ['budget_control_cutovers', 'budget_account_opening_evidence']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`);
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY ${table}_isolation[\\s\\S]*?USING \\(builder_id = current_setting\\('app\\.builder_id', true\\)::UUID\\)[\\s\\S]*?WITH CHECK \\(builder_id = current_setting\\('app\\.builder_id', true\\)::UUID\\)`,
        ),
      );
    }
  });
});
