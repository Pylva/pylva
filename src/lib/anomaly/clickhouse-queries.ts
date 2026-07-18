// Period-aggregation queries over the canonical mixed event view for the anomaly cron.
// Tenant safety: every query goes through `queryCostEvents`, which
// injects `builder_id` as a parameterized binding, and the SQL itself
// pins `WHERE builder_id = {builder_id:String}` — both gates are
// mandatory (R7). The cron runs server-side with no JWT, so the
// API-seam `assertBuilderId` guard does not apply here.
//
// is_demo = 0 on every read: anomaly detection acts on REAL traffic
// only, exactly like previewRule, aggregateSpendForRule (PR #229), and
// every dashboard query. Without it, seeded demo events (is_demo=1,
// never purged) feed the cost_spike / cost_drop baselines and the
// builder-discovery / cold-start sweep: as static demo rows age out of
// the trailing-24h window but stay in the 30-day baseline, currentCost
// collapses to ~0 while the baseline stays inflated → a false
// COST_DROP fires (and real spikes get masked by the demo-padded
// baseline). The predicate is a no-op for builders without demo rows
// (column defaults to 0).

import { queryCostEvents } from '../clickhouse/client.js';
import { toCompositeCustomerId } from '../clickhouse/customer-id.js';
import { chTimestamp, parseChTimestamp, DAY_MS, HOUR_MS } from '../clickhouse/datetime.js';

import type { ModeledSlice, SourcedSlice, SteppedSlice } from '../rules/margin-diagnosis.js';

export interface PeriodSlices {
  steps: SteppedSlice[];
  models: ModeledSlice[];
  sources: SourcedSlice[];
}

export interface PeriodAggregates {
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  /** All slices, builder-level (no customer filter applied). */
  all: PeriodSlices;
  /** Same slices pre-bucketed by external customer_id; the null bucket
   *  surfaces telemetry that arrived without a customer_id. Lets the
   *  cron walk per-customer in O(1) instead of re-filtering for each. */
  byCustomer: Map<string | null, PeriodSlices>;
  /** Per-customer cost totals — derived once at fetch time so the
   *  detectors don't re-walk the slice arrays. */
  costByCustomer: Map<string | null, number>;
}

/**
 * Cost for a customer given its bare EXTERNAL id (or null for the
 * builder-level total). `costByCustomer` is keyed by the composite
 * ClickHouse key, so this re-composes before the lookup — the single
 * place that knows external ids must be re-prefixed to index the map.
 */
export function costForExternalCustomer(
  agg: Pick<PeriodAggregates, 'total_cost_usd' | 'costByCustomer'>,
  builderId: string,
  externalCustomerId: string | null,
): number {
  if (externalCustomerId === null) return agg.total_cost_usd;
  return agg.costByCustomer.get(toCompositeCustomerId(builderId, externalCustomerId)) ?? 0;
}

interface RawTotalsRow extends Record<string, unknown> {
  total_cost_usd: string;
  total_tokens_in: string;
  total_tokens_out: string;
}

interface RawStepRow extends Record<string, unknown> {
  customer_id: string;
  step_name: string;
  cost_usd: string;
  iterations: string;
}

interface RawModelRow extends Record<string, unknown> {
  customer_id: string;
  provider: string;
  model: string;
  cost_usd: string;
}

interface RawSourceRow extends Record<string, unknown> {
  customer_id: string;
  source: string;
  cost_usd: string;
}

function nullable(value: string): string | null {
  return value === '' ? null : value;
}

function emptySlices(): PeriodSlices {
  return { steps: [], models: [], sources: [] };
}

function bucketFor(map: Map<string | null, PeriodSlices>, key: string | null): PeriodSlices {
  let entry = map.get(key);
  if (!entry) {
    entry = emptySlices();
    map.set(key, entry);
  }
  return entry;
}

export async function fetchPeriodAggregates(
  builderId: string,
  fromIso: string,
  toIso: string,
): Promise<PeriodAggregates> {
  const [totalsRows, stepRows, modelRows, sourceRows] = await Promise.all([
    queryCostEvents(
      builderId,
      `SELECT
         sum(cost_usd) AS total_cost_usd,
         sum(tokens_in) AS total_tokens_in,
         sum(tokens_out) AS total_tokens_out
       FROM cost_events_with_control
       WHERE builder_id = {builder_id:String}
         AND is_demo = 0
         AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
         AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')`,
      { from: fromIso, to: toIso },
    ) as Promise<RawTotalsRow[]>,
    queryCostEvents(
      builderId,
      `SELECT
         customer_id,
         step_name,
         sum(cost_usd) AS cost_usd,
         count() AS iterations
       FROM cost_events_with_control
       WHERE builder_id = {builder_id:String}
         AND is_demo = 0
         AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
         AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
       GROUP BY customer_id, step_name`,
      { from: fromIso, to: toIso },
    ) as Promise<RawStepRow[]>,
    queryCostEvents(
      builderId,
      `SELECT
         customer_id,
         provider,
         model,
         sum(cost_usd) AS cost_usd
       FROM cost_events_with_control
       WHERE builder_id = {builder_id:String}
         AND is_demo = 0
         AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
         AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
       GROUP BY customer_id, provider, model`,
      { from: fromIso, to: toIso },
    ) as Promise<RawModelRow[]>,
    queryCostEvents(
      builderId,
      // The table column is cost_source ('auto'|'configured'|'reported');
      // selecting bare `source` threw "Unknown expression identifier" and
      // failed EVERY period-aggregate fetch — the spike/drop cron never
      // completed a real run (unit suites mock this module).
      `SELECT
         customer_id,
         cost_source AS source,
         sum(cost_usd) AS cost_usd
       FROM cost_events_with_control
       WHERE builder_id = {builder_id:String}
         AND is_demo = 0
         AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
         AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
       GROUP BY customer_id, cost_source`,
      { from: fromIso, to: toIso },
    ) as Promise<RawSourceRow[]>,
  ]);

  const byCustomer = new Map<string | null, PeriodSlices>();
  const costByCustomer = new Map<string | null, number>();

  for (const r of stepRows) {
    const customer_id = nullable(r.customer_id);
    const slice: SteppedSlice = {
      step_name: nullable(r.step_name),
      cost_usd: Number(r.cost_usd ?? 0),
      iterations: Number(r.iterations ?? 0),
    };
    bucketFor(byCustomer, customer_id).steps.push(slice);
    costByCustomer.set(customer_id, (costByCustomer.get(customer_id) ?? 0) + slice.cost_usd);
  }
  for (const r of modelRows) {
    const customer_id = nullable(r.customer_id);
    const slice: ModeledSlice = {
      provider: nullable(r.provider),
      model: nullable(r.model),
      cost_usd: Number(r.cost_usd ?? 0),
    };
    bucketFor(byCustomer, customer_id).models.push(slice);
  }
  for (const r of sourceRows) {
    const customer_id = nullable(r.customer_id);
    const slice: SourcedSlice = {
      source: nullable(r.source),
      cost_usd: Number(r.cost_usd ?? 0),
    };
    bucketFor(byCustomer, customer_id).sources.push(slice);
  }

  const totals = totalsRows[0];
  return {
    total_cost_usd: Number(totals?.total_cost_usd ?? 0),
    total_tokens_in: Number(totals?.total_tokens_in ?? 0),
    total_tokens_out: Number(totals?.total_tokens_out ?? 0),
    all: collapseByKey(byCustomer),
    byCustomer,
    costByCustomer,
  };
}

// `\0` is forbidden by the telemetry step_name / model regex
// (`packages/shared/src/types/telemetry.ts`) — collision-proof null-key
// sentinel. Same convention as `src/lib/rules/margin-diagnosis.ts`.
const NULL_KEY = '\0';

/**
 * Builder-level (`agg.all`) needs one entry per (step_name) /
 * (provider, model) / (source) — not one per (customer, key) pair.
 * The CH queries `GROUP BY customer_id, key`, so the same key appears
 * once per customer. `diffByKey` in margin-diagnosis.ts uses
 * `map.set(...)` on the prior loop, which silently overwrites
 * duplicates and reports incorrect deltas for builders with >1
 * customer per step/model. Collapsing by key here is the upstream fix.
 */
function collapseByKey(byCustomer: Map<string | null, PeriodSlices>): PeriodSlices {
  const stepSums = new Map<string, SteppedSlice>();
  const modelSums = new Map<string, ModeledSlice>();
  const sourceSums = new Map<string, SourcedSlice>();

  for (const slices of byCustomer.values()) {
    for (const s of slices.steps) {
      const k = s.step_name ?? NULL_KEY;
      const acc = stepSums.get(k);
      if (acc) {
        acc.cost_usd += s.cost_usd;
        acc.iterations += s.iterations;
      } else {
        stepSums.set(k, { ...s });
      }
    }
    for (const m of slices.models) {
      const k = `${m.provider ?? NULL_KEY}|${m.model ?? NULL_KEY}`;
      const acc = modelSums.get(k);
      if (acc) {
        acc.cost_usd += m.cost_usd;
      } else {
        modelSums.set(k, { ...m });
      }
    }
    for (const src of slices.sources) {
      const k = src.source ?? NULL_KEY;
      const acc = sourceSums.get(k);
      if (acc) {
        acc.cost_usd += src.cost_usd;
      } else {
        sourceSums.set(k, { ...src });
      }
    }
  }

  return {
    steps: [...stepSums.values()],
    models: [...modelSums.values()],
    sources: [...sourceSums.values()],
  };
}

// Test surface — exported for the regression test that proves
// builder-level diagnosis sums correctly across customers (bug_011).
export const __test__ = { collapseByKey };

interface RawDistinctBuilderRow extends Record<string, unknown> {
  builder_id: string;
  earliest: string;
}

/**
 * One read replaces (a) "list all builders" and (b) per-builder
 * `min(timestamp)` cold-start lookups. Returns only builders with
 * telemetry — builders without events skip the cycle entirely.
 *
 * The query reads with `builder_id = {builder_id:String}` removed
 * intentionally — this is a server-side discovery query, not a
 * tenant-scoped read; the caller passes each returned id back through
 * `queryCostEvents(builderId, …)` for any subsequent work.
 */
export async function listBuildersWithEvents(
  now: Date,
): Promise<Array<{ builderId: string; earliestEvent: Date }>> {
  // ClickHouse's `query_params.builder_id` injection is harmless when
  // the query never references it; we pass an empty string so the same
  // wrapper can be used for the discovery sweep.
  const rows = (await queryCostEvents(
    '',
    // is_demo = 0 here too: discovery + the earliestEvent that drives the
    // cold-start gate must reflect REAL telemetry age. A builder seeded with
    // 30 days of demo data but only 2 days of real traffic would otherwise
    // clear the 7-day cold-start gate and get anomalies computed on sparse
    // real data against a demo-padded baseline.
    `SELECT builder_id, min(timestamp) AS earliest
     FROM cost_events_with_control
     WHERE is_demo = 0
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
     GROUP BY builder_id`,
    { from: chTimestamp(new Date(now.getTime() - 60 * DAY_MS)) },
  )) as RawDistinctBuilderRow[];

  const out: Array<{ builderId: string; earliestEvent: Date }> = [];
  for (const r of rows) {
    const earliest = parseChTimestamp(r.earliest);
    if (!r.builder_id || !earliest) continue;
    out.push({ builderId: r.builder_id, earliestEvent: earliest });
  }
  return out;
}

export interface SourceLastSeen {
  source: string;
  last_seen: Date;
  events_last_24h: number;
}

/**
 * D56: source silence is re-derived from canonical mixed events here so the cron
 * doesn't depend on the B3-T4b health table's status column.
 */
export async function fetchSourceLastSeen(
  builderId: string,
  now: Date,
  lookbackDays = 30,
): Promise<SourceLastSeen[]> {
  const from = chTimestamp(new Date(now.getTime() - lookbackDays * DAY_MS));
  const dayCutoff = chTimestamp(new Date(now.getTime() - DAY_MS));
  const rows = (await queryCostEvents(
    builderId,
    `SELECT
       cost_source AS source,
       max(timestamp) AS last_seen,
       sum(if(timestamp >= parseDateTime64BestEffort({day_cutoff:String}, 3, 'UTC'), 1, 0)) AS events_last_24h
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND is_demo = 0
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND cost_source <> ''
     GROUP BY cost_source`,
    { from, day_cutoff: dayCutoff },
  )) as Array<{ source: string; last_seen: string; events_last_24h: string }>;

  const out: SourceLastSeen[] = [];
  for (const r of rows) {
    const last_seen = parseChTimestamp(r.last_seen);
    if (!last_seen) continue;
    out.push({
      source: r.source,
      last_seen,
      events_last_24h: Number(r.events_last_24h ?? 0),
    });
  }
  return out;
}

/**
 * Most recent `pylva validate --ci` deploy signal. Returns null
 * when no signal exists in the lookback window — callers skip the
 * deploy_drop detector for this period. The signal is a telemetry event
 * with `step_name = 'pylva:ci'` (SDK validator contract).
 */
export async function fetchDeployValidationSignal(
  builderId: string,
  now: Date,
  lookbackHours = 48,
): Promise<Date | null> {
  const from = chTimestamp(new Date(now.getTime() - lookbackHours * HOUR_MS));
  const rows = (await queryCostEvents(
    builderId,
    `SELECT max(timestamp) AS deploy_at
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND is_demo = 0
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND step_name = 'pylva:ci'`,
    { from },
  )) as Array<{ deploy_at: string | null }>;
  return parseChTimestamp(rows[0]?.deploy_at);
}
