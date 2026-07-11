// ClickHouse dashboard query helpers (B1 — §7.2).
// Every query function here hard-codes `WHERE builder_id = {builderId:String}`
// before any user-provided filter can be appended (R7 tenant isolation).
// Never accept a raw `WHERE` string from a caller.

import { queryCostEvents } from './client.js';

export interface BuilderCostSummary {
  total_events: number;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
}

/**
 * Summary across a builder's cost_events within a time window. Aggregates
 * over Nullable cost_usd using sum() (NULLs treated as 0, consistent with
 * the cost_daily_agg_v2 MV target).
 */
export async function getBuilderCostSummary(
  builderId: string,
  fromIso: string,
  toIso: string,
): Promise<BuilderCostSummary> {
  const rows = await queryCostEvents(
    builderId,
    `SELECT
       count() AS total_events,
       sum(cost_usd) AS total_cost_usd,
       sum(tokens_in) AS total_tokens_in,
       sum(tokens_out) AS total_tokens_out
     FROM cost_events
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTimeBestEffort({from:String})
       AND timestamp <  parseDateTimeBestEffort({to:String})`,
    { from: fromIso, to: toIso },
  );
  const r = (rows[0] as Record<string, unknown> | undefined) ?? {};
  return {
    total_events: Number(r['total_events'] ?? 0),
    total_cost_usd: Number(r['total_cost_usd'] ?? 0),
    total_tokens_in: Number(r['total_tokens_in'] ?? 0),
    total_tokens_out: Number(r['total_tokens_out'] ?? 0),
  };
}

export interface CustomerCostRow {
  customer_id: string;
  total_cost_usd: number;
  event_count: number;
}

/**
 * Per-customer spend breakdown for the given builder, ordered by cost descending.
 */
export async function getCostsByCustomer(
  builderId: string,
  fromIso: string,
  toIso: string,
  limit = 100,
): Promise<CustomerCostRow[]> {
  const rows = await queryCostEvents(
    builderId,
    `SELECT
       customer_id,
       sum(cost_usd) AS total_cost_usd,
       count() AS event_count
     FROM cost_events
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTimeBestEffort({from:String})
       AND timestamp <  parseDateTimeBestEffort({to:String})
     GROUP BY customer_id
     ORDER BY total_cost_usd DESC
     LIMIT {lim:UInt32}`,
    { from: fromIso, to: toIso, lim: limit },
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    customer_id: String(r['customer_id'] ?? ''),
    total_cost_usd: Number(r['total_cost_usd'] ?? 0),
    event_count: Number(r['event_count'] ?? 0),
  }));
}
