// SPDX-License-Identifier: Elastic-2.0
// B2b T2-B — ClickHouse usage aggregation for pricing preview + invoice gen.
//
// I-T2-5 (unpriced-window): we SUM only priced events into the usage figures,
// but count unpriced rows separately so the caller can set `has_unpriced_events`
// on the resulting invoice / preview response.
//
// Hot-path note: this query hits `cost_events` (live), not the daily MV —
// preview + invoice gen need exact boundary precision. For dashboard reads
// use `dashboard-queries.ts` instead.

import { queryCostEvents } from '../clickhouse/client.js';
import { chTimestamp } from '../clickhouse/datetime.js';
import type { UsageAggregate } from './formulas.js';

export async function getUsageForPeriod(params: {
  builderId: string;
  customerId: string;
  from: Date;
  to: Date;
}): Promise<UsageAggregate> {
  const from = chTimestamp(params.from);
  const to = chTimestamp(params.to);

  // Single scan: per-metric sums (priced only), LLM token totals (priced
  // only), and unpriced-row count. Grouping by `metric` keeps NULL rows
  // (LLM events) separate so token sums don't double-count. The outer
  // aggregation folds the two shapes together client-side.
  const rows = await queryCostEvents(
    params.builderId,
    // Alias the grouped key `metric_key` (NOT `metric`): aliasing it `metric`
    // shadows the raw column, so the `isNull(metric)` predicates below would bind
    // to coalesce(metric,'') (never NULL) and LLM token sums would always be 0 —
    // silently zeroing pay-as-you-go token billing. Keep the predicate on the column.
    `SELECT
       ifNull(metric, '') AS metric_key,
       sum(if(pricing_status = 'priced', metric_value, 0)) AS metric_value_sum,
       sum(if(pricing_status = 'priced' AND isNull(metric), tokens_in, 0))  AS tokens_in_sum,
       sum(if(pricing_status = 'priced' AND isNull(metric), tokens_out, 0)) AS tokens_out_sum,
       countIf(pricing_status != 'priced') AS unpriced_count
     FROM cost_events
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTimeBestEffort({from:String})
       AND timestamp <  parseDateTimeBestEffort({to:String})
     GROUP BY metric_key`,
    { customer_id: params.customerId, from, to },
  );

  const byMetric: Record<string, number> = {};
  let unpricedCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const r of rows as Array<Record<string, unknown>>) {
    const metric = String(r['metric_key'] ?? '');
    const metricValue = Number(r['metric_value_sum'] ?? 0);
    if (metric && metricValue > 0) byMetric[metric] = metricValue;
    inputTokens += Number(r['tokens_in_sum'] ?? 0);
    outputTokens += Number(r['tokens_out_sum'] ?? 0);
    unpricedCount += Number(r['unpriced_count'] ?? 0);
  }

  if (inputTokens > 0) byMetric['input_tokens'] = inputTokens;
  if (outputTokens > 0) byMetric['output_tokens'] = outputTokens;

  return {
    by_model: {}, // reserved for per-model pricing (B6 territory)
    by_metric: byMetric,
    has_unpriced: unpricedCount > 0,
  };
}
