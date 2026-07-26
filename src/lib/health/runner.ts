// Hourly health-check orchestrator. Per-builder loop isolates ClickHouse
// failures so one bad source doesn't kill the cycle; alerts are dispatched
// in parallel after the source loop so a slow webhook can't stall the cron's
// 60s budget.

import { sql, eq } from 'drizzle-orm';
import {
  WebhookEventType,
  CostSourceStatus,
  type WebhookPayload,
  type InstrumentationSilencePayload,
  type InstrumentationCostDropPayload,
} from '@pylva/shared';
import { db } from '../db/client.js';
import { costSources } from '../db/schema.js';
import { withRLS } from '../db/rls.js';
import { queryCostEvents } from '../clickhouse/client.js';
import { chTimestamp } from '../clickhouse/datetime.js';
import {
  deliverBuilderAlert,
  type DeliverBuilderAlertOutcome,
} from '../alerts/builder-alert.js';
import { logger } from '../logger.js';
import {
  evaluateSourceHealth,
  DAY_MS,
  LOOKBACK_DAYS,
  type DailyEventRow,
  type SourceHealthEvaluation,
} from './source-checker.js';
import { authorizeBuilderCapability } from '../auth/builder-entitlement.js';
import { getBuilderEntitlementForShare } from '../db/advisory-locks.js';

const BUILDER_CONCURRENCY = 5;

interface CostSourceRow {
  id: string;
  builder_id: string;
  source_type: string;
  display_name: string;
  slug: string;
  metric: string | null;
  last_seen_at: Date | null;
  status: CostSourceStatus;
}

interface CHAggRow {
  day: string;
  provider: string;
  metric: string | null;
  event_count: string;
  cost_usd: string;
}

export interface HealthCheckResult {
  scanned_builders: number;
  scanned_sources: number;
  silence_alerts: number;
  cost_drop_alerts: number;
  cold_start: number;
  status_changes: number;
  errors: number;
}

type BuilderSummary = Omit<HealthCheckResult, 'scanned_builders' | 'errors'>;

const EMPTY_SUMMARY: BuilderSummary = {
  scanned_sources: 0,
  silence_alerts: 0,
  cost_drop_alerts: 0,
  cold_start: 0,
  status_changes: 0,
};

export async function runHealthCheck({
  now = new Date(),
}: { now?: Date } = {}): Promise<HealthCheckResult> {
  const log = logger.child({ module: 'health.runner' });
  const builderIds = await listBuildersWithSources();

  const result: HealthCheckResult = {
    scanned_builders: builderIds.length,
    scanned_sources: 0,
    silence_alerts: 0,
    cost_drop_alerts: 0,
    cold_start: 0,
    status_changes: 0,
    errors: 0,
  };

  for (let i = 0; i < builderIds.length; i += BUILDER_CONCURRENCY) {
    const batch = builderIds.slice(i, i + BUILDER_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((id) => checkBuilderSources(id, now)));
    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j]!;
      if (outcome.status === 'fulfilled') {
        accumulate(result, outcome.value);
      } else {
        result.errors += 1;
        log.error(
          {
            builder_id: batch[j],
            error:
              outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
          },
          'health check failed for builder',
        );
      }
    }
  }

  log.info(result, 'health check cycle complete');
  return result;
}

function accumulate(result: HealthCheckResult, summary: BuilderSummary): void {
  result.scanned_sources += summary.scanned_sources;
  result.silence_alerts += summary.silence_alerts;
  result.cost_drop_alerts += summary.cost_drop_alerts;
  result.cold_start += summary.cold_start;
  result.status_changes += summary.status_changes;
}

async function listBuildersWithSources(): Promise<string[]> {
  const rows = await db.execute<{ builder_id: string }>(
    sql`SELECT DISTINCT builder_id FROM cost_sources`,
  );
  return rows.map((r) => r.builder_id);
}

interface PendingStatusUpdate {
  source_id: string;
  next_status: CostSourceStatus;
}

async function retainsProductAccess(builderId: string): Promise<boolean> {
  const entitlement = await authorizeBuilderCapability(builderId, 'product');
  if (entitlement.allowed) return true;

  // A database lookup outage is an operational failure, not an empty
  // workspace. Surface it so an all-builders outage still fails the cron.
  if (entitlement.lookup.kind === 'lookup_failed') {
    throw new Error('workspace entitlement lookup failed');
  }
  return false;
}

function clearPendingEffectCounts(summary: BuilderSummary): void {
  summary.silence_alerts = 0;
  summary.cost_drop_alerts = 0;
  summary.status_changes = 0;
}

async function checkBuilderSources(builderId: string, now: Date): Promise<BuilderSummary> {
  const summary: BuilderSummary = { ...EMPTY_SUMMARY };
  if (!(await retainsProductAccess(builderId))) return summary;

  const sources = await loadSources(builderId);
  if (sources.length === 0) return summary;

  const dailyByKey = await loadDailyAggregates(builderId, now);

  const pendingAlerts: WebhookPayload[] = [];
  const pendingUpdates: PendingStatusUpdate[] = [];

  for (const source of sources) {
    summary.scanned_sources += 1;
    const series = pickSeriesForSource(source, dailyByKey);
    const evaluation = evaluateSourceHealth(series, source.last_seen_at, now);

    if (evaluation.cold_start) summary.cold_start += 1;

    if (evaluation.silence) {
      pendingAlerts.push(buildSilencePayload(builderId, source, evaluation.silence));
    }
    if (evaluation.cost_drop) {
      pendingAlerts.push(buildCostDropPayload(builderId, source, evaluation.cost_drop));
    }

    const nextStatus = decideStatus(evaluation);
    if (nextStatus !== source.status) {
      pendingUpdates.push({ source_id: source.id, next_status: nextStatus });
      summary.status_changes += 1;
    }
  }

  if (
    (pendingUpdates.length > 0 || pendingAlerts.length > 0) &&
    !(await retainsProductAccess(builderId))
  ) {
    clearPendingEffectCounts(summary);
    return summary;
  }

  if (pendingUpdates.length > 0) {
    const statusesUpdated = await batchUpdateStatus(builderId, pendingUpdates);
    if (!statusesUpdated) {
      clearPendingEffectCounts(summary);
      return summary;
    }
  }
  const deliveryOutcomes = await Promise.all(
    pendingAlerts.map((payload) => dispatchAlert(builderId, payload)),
  );
  for (let index = 0; index < deliveryOutcomes.length; index++) {
    if (deliveryOutcomes[index]?.kind !== 'delivered') continue;
    const payload = pendingAlerts[index];
    if (payload?.type === WebhookEventType.INSTRUMENTATION_SILENCE) {
      summary.silence_alerts += 1;
    } else if (payload?.type === WebhookEventType.INSTRUMENTATION_COST_DROP) {
      summary.cost_drop_alerts += 1;
    }
  }

  return summary;
}

async function loadSources(builderId: string): Promise<CostSourceRow[]> {
  return withRLS(builderId, async (tx) => {
    const rows = await tx
      .select({
        id: costSources.id,
        builder_id: costSources.builder_id,
        source_type: costSources.source_type,
        display_name: costSources.display_name,
        slug: costSources.slug,
        metric: costSources.metric,
        last_seen_at: costSources.last_seen_at,
        status: costSources.status,
      })
      .from(costSources)
      .where(eq(costSources.builder_id, builderId));
    return rows.map((r) => ({ ...r, status: r.status as CostSourceStatus }));
  });
}

async function loadDailyAggregates(
  builderId: string,
  now: Date,
): Promise<Map<string, DailyEventRow[]>> {
  const from = chTimestamp(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const to = chTimestamp(now);

  const rows = (await queryCostEvents(
    builderId,
    `SELECT
       toString(toDate(timestamp)) AS day,
       provider,
       metric,
       count() AS event_count,
       sum(cost_usd) AS cost_usd
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
     GROUP BY day, provider, metric
     ORDER BY day ASC`,
    { from, to },
  )) as CHAggRow[];

  const byKey = new Map<string, DailyEventRow[]>();
  for (const r of rows) {
    pushRow(byKey, `provider:${r.provider}`, r);
    if (r.metric) pushRow(byKey, `metric:${r.metric}`, r);
  }
  return byKey;
}

function pushRow(byKey: Map<string, DailyEventRow[]>, key: string, r: CHAggRow): void {
  const list = byKey.get(key) ?? [];
  list.push({
    day: r.day,
    event_count: Number(r.event_count),
    cost_usd: Number(r.cost_usd),
  });
  byKey.set(key, list);
}

function pickSeriesForSource(
  source: CostSourceRow,
  byKey: Map<string, DailyEventRow[]>,
): DailyEventRow[] {
  const key =
    source.source_type === 'llm_provider'
      ? `provider:${source.display_name}`
      : source.metric
        ? `metric:${source.metric}`
        : null;
  return key ? (byKey.get(key) ?? []) : [];
}

function decideStatus(evaluation: SourceHealthEvaluation): CostSourceStatus {
  if (evaluation.silence?.reason === 'absolute_ceiling') return CostSourceStatus.BROKEN;
  if (evaluation.silence || evaluation.cost_drop) return CostSourceStatus.WARNING;
  return CostSourceStatus.HEALTHY;
}

async function batchUpdateStatus(
  builderId: string,
  updates: PendingStatusUpdate[],
): Promise<boolean> {
  if (updates.length === 0) return true;

  // CASE WHEN id = $X THEN $Y ... — one round-trip per builder regardless of
  // how many sources changed.
  const cases = sql.join(
    updates.map((u) => sql`WHEN ${u.source_id}::uuid THEN ${u.next_status}`),
    sql.raw(' '),
  );
  const ids = sql.join(
    updates.map((u) => sql`${u.source_id}::uuid`),
    sql.raw(', '),
  );

  return withRLS(builderId, async (tx) => {
    // Hold a share lock on the authoritative builder lifecycle row through
    // the status update. A concurrent suspension must either commit first
    // (and suppress this write) or wait until this already-authorized write
    // commits; it cannot land between the check and mutation.
    const resolution = await getBuilderEntitlementForShare(tx, builderId);
    if (resolution === null || !resolution.ok || !resolution.entitlement.has_product_access) {
      return false;
    }
    await tx.execute(sql`
      UPDATE cost_sources
      SET status = CASE id ${cases} END
      WHERE builder_id = ${builderId} AND id IN (${ids})
    `);
    return true;
  });
}

function buildSilencePayload(
  builderId: string,
  source: CostSourceRow,
  finding: NonNullable<SourceHealthEvaluation['silence']>,
): InstrumentationSilencePayload {
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.INSTRUMENTATION_SILENCE,
    builder_id: builderId,
    timestamp: new Date().toISOString(),
    data: {
      source_slug: source.slug,
      source_display_name: source.display_name,
      last_seen_at: source.last_seen_at?.toISOString() ?? null,
      silent_hours: finding.silent_hours,
      longest_historical_gap_hours: finding.longest_historical_gap_hours,
    },
  };
}

function buildCostDropPayload(
  builderId: string,
  source: CostSourceRow,
  finding: NonNullable<SourceHealthEvaluation['cost_drop']>,
): InstrumentationCostDropPayload {
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.INSTRUMENTATION_COST_DROP,
    builder_id: builderId,
    timestamp: new Date().toISOString(),
    data: {
      source_slug: source.slug,
      source_display_name: source.display_name,
      rolling_7d_avg_usd: finding.rolling_7d_avg_usd,
      rolling_30d_avg_usd: finding.rolling_30d_avg_usd,
      drop_percent: finding.drop_percent,
    },
  };
}

async function dispatchAlert(
  builderId: string,
  payload: WebhookPayload,
): Promise<DeliverBuilderAlertOutcome> {
  try {
    return await deliverBuilderAlert({ builderId, payload });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        module: 'health.runner',
        builder_id: builderId,
        type: payload.type,
        error,
      },
      'builder alert dispatch failed; skipping',
    );
    return { kind: 'failed', error };
  }
}
