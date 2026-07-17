// Phase-4 integration harness for the per-customer rules matrix tests.
// Seeds hundreds of customers + a rule matrix through the REAL repository
// (RLS, defaults, validation all live), ingests telemetry through the REAL
// public handler (composite ids, budget_exceeded flags, post-call eval),
// and cleans up both stores.
//
// Each RuleSpec carries its OWN expectations (`expect.appliesTo` /
// `visibleToSdk` / `firesAlert`) so the matrix tests have a single source
// of truth: assertions iterate the specs instead of re-deriving targeting
// rules in test code — if targeting semantics change, the spec is the one
// place to update.

import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import { clickhouse } from '../../src/lib/clickhouse/client.js';
import { toCompositeCustomerId } from '../../src/lib/clickhouse/customer-id.js';
import { handleTelemetryIngest } from '../../src/lib/ingest/public-handler.js';
import { createRule } from '../../src/lib/rules/repository.js';
import type {
  Rule,
  RuleEnforcement as RuleEnforcementT,
  RuleStatus as RuleStatusT,
  RuleType as RuleTypeT,
} from '@pylva/shared';

const INGEST_BATCH_MAX = 100; // TelemetryBatchSchema maxLength

// --- customers ---

/** Bulk-insert `n` customers as `${prefix}_0000`…; returns the external ids. */
export async function seedCustomers(
  sql: Sql,
  builderId: string,
  n: number,
  prefix = 'cust',
): Promise<string[]> {
  const externalIds = Array.from(
    { length: n },
    (_, i) => `${prefix}_${String(i).padStart(4, '0')}`,
  );
  // One multi-row INSERT per 1k rows keeps the seed fast at N=1000+.
  for (let i = 0; i < externalIds.length; i += 1000) {
    const chunk = externalIds.slice(i, i + 1000);
    await sql`
      INSERT INTO customers (builder_id, external_id)
      SELECT ${builderId}, unnest(${sql.array(chunk)}::text[])
      ON CONFLICT (builder_id, external_id) DO NOTHING
    `;
  }
  return externalIds;
}

// --- rules ---

export interface RuleSpecExpectations {
  /** Should listActiveRulesForCustomer(builder, externalId) include this rule? */
  appliesTo: (externalCustomerId: string) => boolean;
  /** Should GET /api/v1/rules with an SDK key serve this rule? */
  visibleToSdk: boolean;
  /** Should the post-call evaluator fire an alert for this rule once its
   *  threshold is crossed? (undefined = not exercised by the alert step) */
  firesAlert?: boolean;
}

export interface RuleSpec {
  /** Stable handle for assertions ("global_hard_5", "targeted_override_50", …). */
  key: string;
  type: RuleTypeT;
  name?: string;
  customer_id?: string | null;
  enabled?: boolean;
  status?: RuleStatusT;
  enforcement?: RuleEnforcementT;
  config: Record<string, unknown>;
  expect: RuleSpecExpectations;
}

/** Create every spec through the real repository; returns rules by spec key. */
export async function seedRuleMatrix(
  builderId: string,
  specs: RuleSpec[],
): Promise<Map<string, Rule>> {
  const byKey = new Map<string, Rule>();
  for (const spec of specs) {
    const rule = await createRule({
      builder_id: builderId,
      type: spec.type,
      name: spec.name ?? spec.key,
      enabled: spec.enabled ?? true,
      customer_id: spec.customer_id ?? null,
      config: spec.config,
      ...(spec.status ? { status: spec.status } : {}),
      ...(spec.enforcement ? { enforcement: spec.enforcement } : {}),
    });
    byKey.set(spec.key, rule);
  }
  return byKey;
}

/**
 * Legacy-row escape hatch: insert a rule via raw SQL, bypassing the create
 * validation. Used to pin behavior for rows that predate a validator rule
 * (e.g. pooled+targeted, which F3 rejects at the API but must still
 * reconcile in budget sync).
 */
export async function insertLegacyRule(
  sql: Sql,
  input: {
    builderId: string;
    type: RuleTypeT;
    name: string;
    customer_id: string | null;
    config: Record<string, unknown>;
    enforcement?: RuleEnforcementT;
    enabled?: boolean;
    status?: RuleStatusT;
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO rules (builder_id, type, enforcement, name, enabled, config, customer_id, status)
    VALUES (
      ${input.builderId},
      ${input.type},
      ${input.enforcement ?? 'pre_call'},
      ${input.name},
      ${input.enabled ?? true},
      ${sql.json(JSON.parse(JSON.stringify(input.config)))},
      ${input.customer_id},
      ${input.status ?? 'active'}
    )
    RETURNING id
  `;
  return row!.id;
}

// --- telemetry ---

export interface MatrixTelemetryOverrides {
  provider?: string;
  model?: string | null;
  tokens_in?: number;
  tokens_out?: number;
  step_name?: string | null;
  status?: string;
  timestamp?: string;
  metric?: string | null;
  metric_value?: number | null;
  cost_source?: string;
}

/** A valid v1.6 telemetry event for `customerId` (fresh run/trace/span ids). */
export function telemetryEvent(
  customerId: string,
  overrides: MatrixTelemetryOverrides = {},
): Record<string, unknown> {
  return {
    schema_version: '1.6',
    run_id: crypto.randomUUID(),
    parent_run_id: null,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    customer_id: customerId,
    step_name: overrides.step_name ?? null,
    model: overrides.model !== undefined ? overrides.model : 'gpt-test',
    provider: overrides.provider ?? 'other',
    tokens_in: overrides.tokens_in ?? 100,
    tokens_out: overrides.tokens_out ?? 100,
    latency_ms: 10,
    tool_name: null,
    status: overrides.status ?? 'success',
    framework: 'none',
    instrumentation_tier: 'sdk_wrapper',
    cost_source: overrides.cost_source ?? 'configured',
    metric: overrides.metric ?? null,
    metric_value: overrides.metric_value ?? null,
    stream_aborted: false,
    abort_savings_usd: 0,
    sdk_version: '1.0.0',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

export interface IngestResult {
  status: number;
  body: {
    accepted?: number;
    rejected?: number;
    budget_exceeded?: Array<{
      rule_id: string;
      customer_id: string | null;
      scope: string;
      accumulated_usd: number;
      period_start: string;
    }>;
    [k: string]: unknown;
  };
}

/**
 * Push events through the REAL ingest handler in ≤100-event batches
 * (TelemetryBatchSchema cap). Returns one result per batch, in order —
 * matrix tests assert on the budget_exceeded flags of specific batches.
 */
export async function ingestEvents(
  builderId: string,
  events: Array<Record<string, unknown>>,
  opts: { keyId?: string } = {},
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (let i = 0; i < events.length; i += INGEST_BATCH_MAX) {
    const chunk = events.slice(i, i + INGEST_BATCH_MAX);
    const response = await handleTelemetryIngest({
      builderId,
      keyId: opts.keyId ?? 'matrix-test-key',
      rawBody: JSON.stringify({
        batch_id: crypto.randomUUID(),
        sdk_version: '1.0.0',
        events: chunk,
      }),
    });
    results.push({
      status: response.status,
      body: JSON.parse(response.body) as IngestResult['body'],
    });
  }
  return results;
}

// --- demo rows (is_demo exclusion probes) ---

/**
 * Insert control rows directly into ClickHouse with is_demo=1. Budget
 * flags/aggregates must NEVER count these; the matrix asserts that seeding
 * demo spend changes nothing. Column set mirrors CostEventRow
 * (src/lib/clickhouse/events.ts) — the canonical ingest insert — plus the
 * explicit is_demo flag (DEFAULT 0 in the table).
 */
export async function insertDemoCostEvents(
  builderId: string,
  rows: Array<{ customerId: string; costUsd: number; timestamp?: Date }>,
): Promise<void> {
  const now = new Date();
  await clickhouse.insert({
    table: 'cost_events',
    format: 'JSONEachRow',
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    values: rows.map((r) => ({
      timestamp: (r.timestamp ?? now).toISOString().replace('T', ' ').slice(0, 19),
      builder_id: builderId,
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      parent_span_id: null,
      customer_id: toCompositeCustomerId(builderId, r.customerId),
      provider: 'other',
      model: 'demo-model',
      operation: 'unknown',
      step_name: null,
      tokens_in: 1,
      tokens_out: 1,
      cost_usd: r.costUsd,
      pricing_status: 'priced',
      latency_ms: 1,
      status: 'success',
      cost_source: 'configured',
      instrumentation_tier: 'sdk_wrapper',
      metric: null,
      metric_value: null,
      stream_aborted: 0,
      abort_savings: 0,
      retention_days: 30,
      billing_retention_days: 365,
      metadata: '{}',
      is_demo: 1,
    })),
  });
}

// --- cleanup ---

/**
 * Remove the mutable ClickHouse fixture rows synchronously.
 *
 * PostgreSQL authority fixtures intentionally survive until the disposable
 * integration database is torn down. Rule creation now records immutable
 * budget-rule revisions whose builder foreign key is RESTRICT, so deleting
 * the builder would invalidate the authority history this suite created.
 */
export async function cleanupMatrixBuilder(_sql: Sql, builderId: string): Promise<void> {
  await clickhouse.command({
    query: 'ALTER TABLE cost_events DELETE WHERE builder_id = {builder:String}',
    query_params: { builder: builderId },
    clickhouse_settings: { mutations_sync: '1' },
  });
}
