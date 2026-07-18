// B2a T1 — dashboard read queries. Every export takes `builderId` as first
// required param (I-T1-1); the middleware injects x-builder-id. Dashboard
// spend/event reads use cost_events_with_control: the canonical union of
// legacy telemetry and the deduplicated authoritative budget projection.
// Existing daily/customer/model aggregates are intentionally bypassed because
// their materialized views consume legacy cost_events only. `cost_usd` is
// Nullable(Decimal); SUM treats NULL as 0 naturally — do NOT wrap it with
// `ifNull` in read queries.

import { randomUUID } from 'node:crypto';
import { cache } from 'react';
import { queryCostEvents } from './client.js';
import { chTimestamp } from './datetime.js';
import { extractExternalCustomerId, toCompositeCustomerId } from './customer-id.js';

const DASHBOARD_QUERY_TIMEOUT_MS = 8_000;

export interface DateRange {
  from: Date;
  to: Date;
}

// Local alias preserves callsite readability while dedup'ing the helper.
const iso = chTimestamp;

// Date bounds are sent as UTC text and every query parses them with an
// explicit UTC timezone. A natively typed DateTime query parameter is interpreted in the
// ClickHouse server timezone, which can hide the newest projected events when
// the application host and server are not configured for UTC.

function dashboardQueryOptions(label: string) {
  const queryLabel = `dashboard.${label}`;
  return {
    // query_id MUST be unique per execution. ClickHouse rejects a second
    // query that reuses a query_id already in flight with
    // QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING (code 216) because
    // replace_running_query defaults to 0 and is set nowhere. A static id
    // like `dashboard.overview` collides whenever the same logical query runs
    // concurrently — two builders loading dashboards at once, the dashboard
    // RSC render racing the /api/v1/costs poll, or the 30s SSE feed-stream
    // refresh overlapping across connected streams — surfacing as a 503 on
    // the hot path. The label prefix keeps the id greppable in
    // system.query_log; the UUID suffix guarantees per-execution uniqueness.
    // queryLabel stays stable for our own structured logs.
    queryId: `${queryLabel}.${randomUUID()}`,
    queryLabel,
    timeoutMs: DASHBOARD_QUERY_TIMEOUT_MS,
  };
}

/** I-T1-13 demo auto-hide predicate. Request-memoized via React cache()
 * during RSC rendering. Uses an existence probe instead of count() so large
 * builders do not scan more rows than needed just to decide empty-state UX. */
export const hasAnyRealEvents = cache(async (builderId: string): Promise<boolean> => {
  const rows = await queryCostEvents(
    builderId,
    `SELECT 1 AS has_real FROM cost_events_with_control
       WHERE builder_id = {builder_id:String} AND is_demo = 0
       LIMIT 1`,
    {},
    dashboardQueryOptions('has_any_real_events'),
  );
  return rows.length > 0;
});

export interface OverviewKpis {
  total_spend_usd: number;
  event_count: number;
  customer_count: number;
  range: DateRange;
  demo_only: boolean;
}

export async function getOverview(
  builderId: string,
  range: DateRange,
  opts: { includeDemo: boolean; hasRealEvents?: boolean } = { includeDemo: false },
): Promise<OverviewKpis> {
  const demoFilter = opts.includeDemo ? '' : 'AND is_demo = 0';
  const rows = await queryCostEvents(
    builderId,
    `SELECT
       sum(cost_usd) AS total_spend_usd,
       count() AS event_count,
       uniqExact(customer_id) AS customer_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${demoFilter}`,
    { from: iso(range.from), to: iso(range.to) },
    dashboardQueryOptions('overview'),
  );
  const row =
    (rows[0] as
      | {
          total_spend_usd?: string;
          event_count?: string;
          customer_count?: string;
        }
      | undefined) ?? {};
  return {
    total_spend_usd: Number(row.total_spend_usd ?? 0),
    event_count: Number(row.event_count ?? 0),
    customer_count: Number(row.customer_count ?? 0),
    range,
    demo_only: !(opts.hasRealEvents ?? (await hasAnyRealEvents(builderId))),
  };
}

export interface EndUserRow {
  customer_id: string;
  total_spend_usd: number;
  event_count: number;
}

export async function getTopEndUsers(
  builderId: string,
  range: DateRange,
  limit = 5,
  opts: { includeDemo: boolean } = { includeDemo: false },
): Promise<EndUserRow[]> {
  const demoFilter = opts.includeDemo ? '' : 'AND is_demo = 0';
  const rows = await queryCostEvents(
    builderId,
    `SELECT
       customer_id,
       sum(cost_usd) AS total_spend_usd,
       count() AS event_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${demoFilter}
     GROUP BY customer_id
     ORDER BY total_spend_usd DESC
     LIMIT {limit:UInt32}`,
    { from: iso(range.from), to: iso(range.to), limit },
    dashboardQueryOptions('top_end_users'),
  );
  return (
    rows as Array<{
      customer_id: string;
      total_spend_usd: string;
      event_count: string;
    }>
  ).map((r) => ({
    customer_id: extractExternalCustomerId(r.customer_id, builderId),
    total_spend_usd: Number(r.total_spend_usd),
    event_count: Number(r.event_count),
  }));
}

export interface CustomerSummaryRow {
  customer_id: string;
  total_spend_usd: number;
  event_count: number;
  last_seen_at: string | null; // ISO 8601
}

export async function getCustomerCostSummary(
  builderId: string,
  range: DateRange,
  opts: { includeDemo: boolean; limit?: number; offset?: number } = {
    includeDemo: false,
  },
): Promise<CustomerSummaryRow[]> {
  const demoFilter = opts.includeDemo ? '' : 'AND is_demo = 0';
  const rows = await queryCostEvents(
    builderId,
    `SELECT
       customer_id,
       sum(cost_usd) AS total_spend_usd,
       count() AS event_count,
       max(timestamp) AS last_seen_at
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${demoFilter}
     GROUP BY customer_id
     ORDER BY total_spend_usd DESC
     LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    {
      from: iso(range.from),
      to: iso(range.to),
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
    },
    dashboardQueryOptions('customer_summary'),
  );
  return (
    rows as Array<{
      customer_id: string;
      total_spend_usd: string;
      event_count: string;
      last_seen_at: string | null;
    }>
  ).map((r) => ({
    customer_id: extractExternalCustomerId(r.customer_id, builderId),
    total_spend_usd: Number(r.total_spend_usd),
    event_count: Number(r.event_count),
    last_seen_at: r.last_seen_at,
  }));
}

export interface CustomerDetail {
  customer_id: string;
  total_spend_usd: number;
  event_count: number;
  by_model: Array<{
    provider: string;
    model: string | null;
    spend_usd: number;
    call_count: number;
  }>;
  by_step: Array<{
    step_name: string | null;
    spend_usd: number;
    call_count: number;
  }>;
  daily: Array<{ day: string; spend_usd: number; event_count: number }>;
}

export async function getCustomerDetail(
  builderId: string,
  customerId: string,
  range: DateRange,
  opts: { includeDemo: boolean } = { includeDemo: false },
): Promise<CustomerDetail> {
  const demoFilter = opts.includeDemo ? '' : 'AND is_demo = 0';
  const base = `FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${demoFilter}`;
  const p = {
    customer_id: customerId,
    from: iso(range.from),
    to: iso(range.to),
  };

  const [totals, byModel, byStep, daily] = await Promise.all([
    queryCostEvents(
      builderId,
      `SELECT sum(cost_usd) AS s, count() AS c ${base}`,
      p,
      dashboardQueryOptions('customer_detail_totals'),
    ),
    queryCostEvents(
      builderId,
      `SELECT provider, model, sum(cost_usd) AS spend_usd, count() AS call_count
       ${base}
       GROUP BY provider, model
       ORDER BY spend_usd DESC
       LIMIT 20`,
      p,
      dashboardQueryOptions('customer_detail_by_model'),
    ),
    queryCostEvents(
      builderId,
      `SELECT step_name, sum(cost_usd) AS spend_usd, count() AS call_count
       ${base}
       GROUP BY step_name
       ORDER BY spend_usd DESC
       LIMIT 20`,
      p,
      dashboardQueryOptions('customer_detail_by_step'),
    ),
    queryCostEvents(
      builderId,
      `SELECT toDate(timestamp) AS day, sum(cost_usd) AS spend_usd, count() AS event_count
       ${base}
       GROUP BY day
       ORDER BY day ASC`,
      p,
      dashboardQueryOptions('customer_detail_daily'),
    ),
  ]);

  const tRow = totals[0] as { s?: string; c?: string } | undefined;
  return {
    customer_id: customerId,
    total_spend_usd: Number(tRow?.s ?? 0),
    event_count: Number(tRow?.c ?? 0),
    by_model: (
      byModel as Array<{
        provider: string;
        model: string | null;
        spend_usd: string;
        call_count: string;
      }>
    ).map((r) => ({
      provider: r.provider,
      model: r.model,
      spend_usd: Number(r.spend_usd),
      call_count: Number(r.call_count),
    })),
    by_step: (
      byStep as Array<{
        step_name: string | null;
        spend_usd: string;
        call_count: string;
      }>
    ).map((r) => ({
      step_name: r.step_name,
      spend_usd: Number(r.spend_usd),
      call_count: Number(r.call_count),
    })),
    daily: (daily as Array<{ day: string; spend_usd: string; event_count: string }>).map((r) => ({
      day: r.day,
      spend_usd: Number(r.spend_usd),
      event_count: Number(r.event_count),
    })),
  };
}

export interface ModelBreakdownRow {
  provider: string;
  model: string | null;
  total_spend_usd: number;
  tokens_in: number;
  tokens_out: number;
  call_count: number;
  avg_usd_per_call: number;
}

export async function getModelBreakdown(
  builderId: string,
  range: DateRange,
  opts: { includeDemo: boolean } = { includeDemo: false },
): Promise<ModelBreakdownRow[]> {
  const demoFilter = opts.includeDemo ? '' : 'AND is_demo = 0';
  const query = `SELECT
       provider,
       model,
       sum(cost_usd) AS total_spend_usd,
       sum(tokens_in) AS tokens_in,
       sum(tokens_out) AS tokens_out,
       count() AS call_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${demoFilter}
     GROUP BY provider, model
     ORDER BY total_spend_usd DESC`;
  const rows = await queryCostEvents(
    builderId,
    query,
    { from: iso(range.from), to: iso(range.to) },
    dashboardQueryOptions('model_breakdown'),
  );
  return (
    rows as Array<{
      provider: string;
      model: string | null;
      total_spend_usd: string;
      tokens_in: string;
      tokens_out: string;
      call_count: string;
    }>
  ).map((r) => {
    const spend = Number(r.total_spend_usd);
    const calls = Number(r.call_count);
    return {
      provider: r.provider,
      model: r.model,
      total_spend_usd: spend,
      tokens_in: Number(r.tokens_in),
      tokens_out: Number(r.tokens_out),
      call_count: calls,
      avg_usd_per_call: calls > 0 ? spend / calls : 0,
    };
  });
}

export interface TraceSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  step_name: string | null;
  provider: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  status: string;
  timestamp: string;
}

/** Returns up to 10K spans for display; larger traces get a "truncated" flag. */
export async function getTraceTree(
  builderId: string,
  traceId: string,
): Promise<{ spans: TraceSpan[]; truncated: boolean; totalSpanCount: number }> {
  const DISPLAY_CAP = 10_000;
  // Count + spans are independent — one ClickHouse wave (launch perf).
  const [countRows, rows] = await Promise.all([
    queryCostEvents(
      builderId,
      `SELECT count() AS c FROM cost_events_with_control
       WHERE builder_id = {builder_id:String} AND trace_id = {trace_id:String}`,
      { trace_id: traceId },
      dashboardQueryOptions('trace_tree_count'),
    ),
    queryCostEvents(
      builderId,
      `SELECT trace_id, span_id, parent_span_id, step_name, provider, model,
         tokens_in, tokens_out, cost_usd, latency_ms, status, timestamp
       FROM cost_events_with_control
       WHERE builder_id = {builder_id:String} AND trace_id = {trace_id:String}
       ORDER BY timestamp ASC
       LIMIT {limit:UInt32}`,
      { trace_id: traceId, limit: DISPLAY_CAP },
      dashboardQueryOptions('trace_tree_spans'),
    ),
  ]);
  const total = Number((countRows[0] as { c?: string } | undefined)?.c ?? 0);
  return {
    spans: (rows as Array<Record<string, string | null>>).map((r) => ({
      trace_id: r.trace_id as string,
      span_id: r.span_id as string,
      parent_span_id: (r.parent_span_id as string) || null,
      step_name: (r.step_name as string) || null,
      provider: r.provider as string,
      model: (r.model as string) || null,
      tokens_in: Number(r.tokens_in),
      tokens_out: Number(r.tokens_out),
      cost_usd: Number(r.cost_usd ?? 0),
      latency_ms: Number(r.latency_ms),
      status: r.status as string,
      timestamp: r.timestamp as string,
    })),
    truncated: total > DISPLAY_CAP,
    totalSpanCount: total,
  };
}

export interface RecentTraceRow {
  trace_id: string;
  started_at: string;
  customer_id: string;
  span_count: number;
  total_spend_usd: number;
  total_latency_ms: number;
}

export async function getRecentTraces(
  builderId: string,
  range: DateRange,
  opts: { includeDemo: boolean; customerId?: string; limit?: number } = {
    includeDemo: false,
  },
): Promise<RecentTraceRow[]> {
  const demoFilter = opts.includeDemo ? '' : 'AND is_demo = 0';
  const customerFilter = opts.customerId ? 'AND customer_id = {customer_id:String}' : '';
  const rows = await queryCostEvents(
    builderId,
    `SELECT
       trace_id,
       min(timestamp) AS started_at,
       any(customer_id) AS customer_id,
       count() AS span_count,
       sum(cost_usd) AS total_spend_usd,
       sum(latency_ms) AS total_latency_ms
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
       ${demoFilter}
       ${customerFilter}
     GROUP BY trace_id
     ORDER BY started_at DESC
     LIMIT {limit:UInt32}`,
    {
      from: iso(range.from),
      to: iso(range.to),
      limit: opts.limit ?? 50,
      // ClickHouse stores composite keys ({builderId}:{externalId}); convert before filtering.
      ...(opts.customerId
        ? { customer_id: toCompositeCustomerId(builderId, opts.customerId) }
        : {}),
    },
    dashboardQueryOptions('recent_traces'),
  );
  return (
    rows as Array<{
      trace_id: string;
      started_at: string;
      customer_id: string;
      span_count: string;
      total_spend_usd: string;
      total_latency_ms: string;
    }>
  ).map((r) => ({
    trace_id: r.trace_id,
    started_at: r.started_at,
    customer_id: extractExternalCustomerId(r.customer_id, builderId),
    span_count: Number(r.span_count),
    total_spend_usd: Number(r.total_spend_usd),
    total_latency_ms: Number(r.total_latency_ms),
  }));
}
