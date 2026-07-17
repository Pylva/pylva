// SPDX-License-Identifier: Elastic-2.0
// B2b T2-B — ClickHouse usage aggregation for pricing preview + invoice gen.
//
// I-T2-5 (unpriced-window): we SUM only priced events into the usage figures,
// but count unpriced rows separately so the caller can set `has_unpriced_events`
// on the resulting invoice / preview response.
//
// Hot-path note: this query hits `cost_events_with_control` (live), not the daily MV —
// preview + invoice gen need exact boundary precision. For dashboard reads
// use `dashboard-queries.ts` instead.

import { queryCostEvents } from '../clickhouse/client.js';
import {
  createBudgetProjectionPostgresStore,
  type BudgetProjectionPostgresStore,
} from '../budget-projection/postgres.js';
import type { UsageAggregate } from './formulas.js';

export class BudgetProjectionPendingError extends Error {
  constructor() {
    super('Authoritative controlled usage is not reconciled through the billing period');
    this.name = 'BudgetProjectionPendingError';
  }
}

export class BillingPeriodOpenError extends Error {
  constructor() {
    super('Billing period must be closed before authoritative usage can be invoiced');
    this.name = 'BillingPeriodOpenError';
  }
}

export class BudgetUsageAggregateError extends Error {
  constructor(field: string) {
    super(`Billing usage aggregate ${field} is not a finite safe number`);
    this.name = 'BudgetUsageAggregateError';
  }
}

interface UsageDependencies {
  projectionStore?: Pick<BudgetProjectionPostgresStore, 'billingGate'>;
  query?: typeof queryCostEvents;
}

function finiteSafeUsage(value: unknown, field: string, integer = false): number {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
  ) {
    throw new BudgetUsageAggregateError(field);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < 0 ||
    Math.abs(parsed) > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(parsed))
  ) {
    throw new BudgetUsageAggregateError(field);
  }
  return Object.is(parsed, -0) ? 0 : parsed;
}

function metricKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BudgetUsageAggregateError('metric_key');
  }
  return value;
}

function assertValidPeriod(from: Date, to: Date): void {
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.getTime() >= to.getTime()
  ) {
    throw new RangeError('Billing usage period must have valid start < end');
  }
}

export async function assertAuthoritativeProjectionReady(
  builderId: string,
  exclusivePeriodEnd: Date,
  dependencies: Pick<UsageDependencies, 'projectionStore'> = {},
): Promise<void> {
  if (!Number.isFinite(exclusivePeriodEnd.getTime())) {
    throw new RangeError('Billing period end must be a valid timestamp');
  }
  const projectionStore = dependencies.projectionStore ?? createBudgetProjectionPostgresStore();
  const gate = await projectionStore.billingGate(builderId, exclusivePeriodEnd.toISOString());
  if (!gate.closed) throw new BillingPeriodOpenError();
  if (!gate.verified) throw new BudgetProjectionPendingError();
}

export async function getUsageForPeriod(
  params: {
    builderId: string;
    customerId: string;
    from: Date;
    to: Date;
    requireAuthoritativeProjectionVerified?: boolean;
    useAuthoritativeBillingFacts?: boolean;
  },
  dependencies: UsageDependencies = {},
): Promise<UsageAggregate> {
  assertValidPeriod(params.from, params.to);
  if (params.requireAuthoritativeProjectionVerified) {
    await assertAuthoritativeProjectionReady(params.builderId, params.to, dependencies);
  }

  const from = params.from.toISOString();
  const to = params.to.toISOString();
  const query = dependencies.query ?? queryCostEvents;

  const sourceQueries =
    params.requireAuthoritativeProjectionVerified || params.useAuthoritativeBillingFacts
      ? [
          // Legacy raw telemetry expires at telemetry retention; controlled
          // typed billing facts remain in the authoritative final view through
          // billing retention even after trace/metadata columns are TTL-purged.
          'cost_events',
          'budget_cost_events_final',
        ]
      : ['cost_events_with_control'];

  // Single scan: per-metric sums (priced only), LLM token totals (priced
  // only), and unpriced-row count. Grouping by `metric` keeps NULL rows
  // (LLM events) separate so token sums don't double-count. The outer
  // aggregation folds the two shapes together client-side.
  const branch = (source: string) => `SELECT
       ifNull(metric, '') AS metric_key,
       toString(sum(if(pricing_status = 'priced', ifNull(metric_value, 0), 0)))
         AS metric_value_sum,
       toString(sum(if(pricing_status = 'priced' AND isNull(metric), tokens_in, 0)))
         AS tokens_in_sum,
       toString(sum(if(pricing_status = 'priced' AND isNull(metric), tokens_out, 0)))
         AS tokens_out_sum,
       toString(countIf(pricing_status != 'priced')) AS unpriced_count,
       toString(countIf(
         pricing_status = 'priced'
         AND isNotNull(metric)
         AND (isNull(metric_value) OR NOT isFinite(toFloat64(metric_value)))
       )) AS invalid_metric_count
     FROM ${source}
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${source === 'budget_cost_events_final' ? 'AND payload_hash_count = 1' : ''}
     GROUP BY metric_key`;

  const rows = await query(
    params.builderId,
    // Keep each storage branch aggregated independently. This preserves the
    // controlled Decimal sum as text instead of forcing it through the legacy
    // Float64 supertype at a UNION boundary.
    sourceQueries.map(branch).join('\nUNION ALL\n'),
    { customer_id: params.customerId, from, to },
  );

  const byMetric: Record<string, number> = {};
  let unpricedCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const r of rows as Array<Record<string, unknown>>) {
    const metric = metricKey(r['metric_key']);
    const invalidMetricCount = finiteSafeUsage(
      r['invalid_metric_count'],
      'invalid_metric_count',
      true,
    );
    if (invalidMetricCount > 0) throw new BudgetUsageAggregateError(`${metric}.non_finite`);
    const metricValue = finiteSafeUsage(r['metric_value_sum'], `${metric || 'llm'}.metric_value`);
    if (metric && metricValue > 0) {
      byMetric[metric] = finiteSafeUsage(
        (byMetric[metric] ?? 0) + metricValue,
        `${metric}.metric_value_total`,
      );
    }
    inputTokens += finiteSafeUsage(r['tokens_in_sum'], 'tokens_in', true);
    outputTokens += finiteSafeUsage(r['tokens_out_sum'], 'tokens_out', true);
    unpricedCount += finiteSafeUsage(r['unpriced_count'], 'unpriced_count', true);
  }

  inputTokens = finiteSafeUsage(inputTokens, 'tokens_in_total', true);
  outputTokens = finiteSafeUsage(outputTokens, 'tokens_out_total', true);
  unpricedCount = finiteSafeUsage(unpricedCount, 'unpriced_count_total', true);

  if (inputTokens > 0) byMetric['input_tokens'] = inputTokens;
  if (outputTokens > 0) byMetric['output_tokens'] = outputTokens;

  return {
    by_model: {}, // reserved for per-model pricing (B6 territory)
    by_metric: byMetric,
    has_unpriced: unpricedCount > 0,
  };
}
