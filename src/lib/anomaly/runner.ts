// Anomaly cron orchestrator.
//
// Cron-owned boundaries (the detectors are pure):
//   - period definition (current = trailing 24h, baseline = 30-day daily mean)
//   - cold-start gate: <7 days of telemetry → skip (D39)
//   - empty-diagnosis short-circuit: skip emit rather than persist + DISMISS
//   - per-builder error isolation: one bad builder must not stall the cycle

import {
  AnomalyRecommendationAction,
  AnomalySourceType,
  type AnomalyRecommendation,
} from '@pylva/shared';
import { chTimestamp, DAY_MS, HOUR_MS } from '../clickhouse/datetime.js';
import { logger } from '../logger.js';
import { listCustomersWithOpenPricing } from '../customers/lookup.js';
import { diagnoseMargin, type MarginDiagnosisInput } from '../rules/margin-diagnosis.js';
import { evaluateMarginRules } from '../rules/margin-evaluator.js';
import { recommendFromDiagnosis } from '../rules/recommendations.js';
import {
  fetchPeriodAggregates,
  listBuildersWithEvents,
  type PeriodAggregates,
  type PeriodSlices,
} from './clickhouse-queries.js';
import { detectCostDrop, detectCostSpike, type DetectorResult } from './detector.js';
import { expireStaleAnomalies, insertAnomalyEvent, isInCooldown } from './repository.js';
import { extractExternalCustomerId } from '../clickhouse/customer-id.js';
import { loadModelTierCatalog } from './model-tier-catalog.js';
import { buildAnomalyDetectedPayload } from '../alerts/anomaly-payloads.js';
import { deliverBuilderAlert } from '../alerts/builder-alert.js';

const log = logger.child({ module: 'anomaly.runner' });

const BUILDER_CONCURRENCY = 5;
const COLD_START_DAYS = 7;
const BASELINE_DAYS = 30;

const EMPTY_SLICES: PeriodSlices = { steps: [], models: [], sources: [] };

export interface RunResult {
  scanned_builders: number;
  cold_start_skipped: number;
  anomalies_inserted: number;
  anomalies_skipped_idempotent: number;
  errors: number;
}

type Catalog = Awaited<ReturnType<typeof loadModelTierCatalog>>;

export async function detectAnomalies({
  now = new Date(),
}: { now?: Date } = {}): Promise<RunResult> {
  // Track 3 PR 3.5 (O22): sweep open anomalies older than 30 days into
  // 'expired' status before the new run. Idempotent and cheap; lets the
  // detector re-create the anomaly fresh if the underlying condition
  // still holds.
  try {
    const expired = await expireStaleAnomalies(now);
    if (expired > 0) log.info({ expired }, 'anomalies marked expired');
  } catch (err) {
    log.warn({ error: formatError(err) }, 'expire-stale-anomalies failed (non-fatal)');
  }

  // Catalog is static across the cron run — load once instead of N times.
  const [catalog, builders] = await Promise.all([
    loadModelTierCatalog(now),
    listBuildersWithEvents(now),
  ]);

  const result: RunResult = {
    scanned_builders: builders.length,
    cold_start_skipped: 0,
    anomalies_inserted: 0,
    anomalies_skipped_idempotent: 0,
    errors: 0,
  };

  for (let i = 0; i < builders.length; i += BUILDER_CONCURRENCY) {
    const batch = builders.slice(i, i + BUILDER_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((b) => detectForBuilder(b.builderId, b.earliestEvent, now, catalog)),
    );
    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j]!;
      if (outcome.status === 'fulfilled') {
        const summary = outcome.value;
        if (summary.cold_start) result.cold_start_skipped += 1;
        result.anomalies_inserted += summary.inserted;
        result.anomalies_skipped_idempotent += summary.skipped_idempotent;
      } else {
        result.errors += 1;
        log.error(
          {
            builder_id: batch[j]?.builderId,
            error: formatError(outcome.reason),
          },
          'anomaly detection failed for builder',
        );
      }
    }
  }

  log.info(result, 'anomaly detection cycle complete');
  return result;
}

function formatError(err: unknown): string {
  // Class-name-only avoids leaking secrets that might appear in the
  // error message (R1 isolation — see feedback_b4_diagnostics.md).
  return err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
}

interface BuilderSummary {
  cold_start: boolean;
  inserted: number;
  skipped_idempotent: number;
}

async function detectForBuilder(
  builderId: string,
  earliestEvent: Date,
  now: Date,
  catalog: Catalog,
): Promise<BuilderSummary> {
  const summary: BuilderSummary = { cold_start: false, inserted: 0, skipped_idempotent: 0 };

  // B4-4c: margin_protection rules are explicit builder configuration, not
  // baseline statistics — they run even inside the spike/drop cold-start
  // window (a builder 3 days in with pricing + a margin rule deserves the
  // alert). Failure is isolated so a margin bug can't stall spike/drop.
  try {
    const margin = await evaluateMarginRules({ builderId, catalog, now });
    summary.inserted += margin.anomalies_inserted;
    summary.skipped_idempotent += margin.anomalies_skipped_idempotent;
    if (margin.rules_evaluated > 0) {
      log.info({ builder_id: builderId, ...margin }, 'margin rules evaluated');
    }
  } catch (err) {
    log.warn(
      { builder_id: builderId, error: formatError(err) },
      'margin evaluation failed (non-fatal)',
    );
  }

  if (now.getTime() - earliestEvent.getTime() < COLD_START_DAYS * DAY_MS) {
    summary.cold_start = true;
    return summary;
  }

  // Truncate `now` to top-of-hour so consecutive cron ticks within the
  // same hour key into identical (period_start, period_end) and migration
  // 030's partial unique index can de-dupe. Without this, ms-precision
  // wall-clock differences make every tick look like a fresh window —
  // the spike re-fires, the webhook re-dispatches, and
  // `anomalies_skipped_idempotent` stays at zero forever.
  const boundary = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  const periodEnd = boundary;
  const periodStart = new Date(boundary.getTime() - DAY_MS);
  const priorStart = new Date(periodStart.getTime() - DAY_MS);
  const baselineStart = new Date(periodStart.getTime() - BASELINE_DAYS * DAY_MS);

  const [currentAgg, priorAgg, baselineAgg, pricedCustomers] = await Promise.all([
    fetchPeriodAggregates(builderId, chTimestamp(periodStart), chTimestamp(periodEnd)),
    fetchPeriodAggregates(builderId, chTimestamp(priorStart), chTimestamp(periodStart)),
    fetchPeriodAggregates(builderId, chTimestamp(baselineStart), chTimestamp(periodStart)),
    // B4-4c: revenue plumbing is live — has_revenue_data below reflects
    // whether the customer has an open pricing version, which unblocks the
    // recommender's DISMISS path for fully-diagnosed anomalies.
    listCustomersWithOpenPricing(builderId, now).catch((err) => {
      log.warn(
        { builder_id: builderId, error: formatError(err) },
        'pricing lookup failed; diagnosing with has_revenue_data=false',
      );
      return [];
    }),
  ]);
  const pricedExternalIds = new Set(pricedCustomers.map((c) => c.external_id));

  // Builder-level + every customer that had spend in either period; a
  // customer that fully went silent (only in prior) still gets diagnosed.
  const customers = new Set<string | null>([null]);
  for (const k of currentAgg.byCustomer.keys()) customers.add(k);
  for (const k of priorAgg.byCustomer.keys()) customers.add(k);

  for (const customerId of customers) {
    // `customerId` is the COMPOSITE ClickHouse key (`<builderId>:<external>`)
    // used to index the period aggregates. Everything we persist or hand to
    // downstream consumers (anomaly_events.customer_id, the recommendation's
    // draft-rule match, the alert payload) must instead carry the bare
    // EXTERNAL id: rules.customer_id is external-by-convention (preview
    // re-prefixes the builder id), `listActiveRulesForCustomer` matches on the
    // external id, the per-customer anomaly filter passes the external id, and
    // `customerIdSchema` forbids the ':' a composite carries. Persisting the
    // composite made convert-to-rule mint a rule that never matched traffic
    // and hid customer-scoped anomalies from the drill-down (bug_012).
    const externalCustomerId =
      customerId === null ? null : extractExternalCustomerId(customerId, builderId);
    const currentCost = costFor(currentAgg, customerId);
    const baselineDailyMean = costFor(baselineAgg, customerId) / BASELINE_DAYS;

    const detectorHits: Array<{ source_type: AnomalySourceType; result: DetectorResult }> = [];
    const spike = detectCostSpike(currentCost, baselineDailyMean);
    if (spike) detectorHits.push({ source_type: AnomalySourceType.COST_SPIKE, result: spike });
    const drop = detectCostDrop(currentCost, baselineDailyMean);
    if (drop) detectorHits.push({ source_type: AnomalySourceType.COST_DROP, result: drop });
    if (detectorHits.length === 0) continue;

    const diagnosisInput: MarginDiagnosisInput = {
      current: slicesFor(currentAgg, customerId),
      prior: slicesFor(priorAgg, customerId),
      // Customer-scoped: does THIS customer have an open pricing version?
      // Builder-level (customerId null): any priced customer counts.
      has_revenue_data:
        externalCustomerId === null
          ? pricedExternalIds.size > 0
          : pricedExternalIds.has(externalCustomerId),
    };
    const diagnosis = diagnoseMargin(diagnosisInput);
    const diagnosisIsEmpty = !(
      diagnosis.top_drivers?.length ||
      diagnosis.iteration_inflation ||
      diagnosis.notes?.length ||
      diagnosis.insufficient_revenue_data
    );
    if (diagnosisIsEmpty) continue;

    const recommendation: AnomalyRecommendation = recommendFromDiagnosis(diagnosis, {
      catalog,
      customer_id: externalCustomerId,
    });
    if (recommendation.action === AnomalyRecommendationAction.DISMISS) continue;

    for (const hit of detectorHits) {
      const inserted = await insertAnomalyEvent({
        builder_id: builderId,
        customer_id: externalCustomerId,
        source_type: hit.source_type,
        severity: hit.result.severity,
        period_start: periodStart,
        period_end: periodEnd,
        actual_value: hit.result.actual_value,
        baseline_value: hit.result.baseline_value,
        delta_pct: hit.result.delta_pct,
        diagnosis,
        recommendation,
      });
      if (inserted) {
        summary.inserted += 1;
        log.info(
          {
            builder_id: builderId,
            anomaly_id: inserted.id,
            customer_id: inserted.customer_id,
            source_type: inserted.source_type,
            severity: inserted.severity,
            actual_value: inserted.actual_value,
            baseline_value: inserted.baseline_value,
            delta_pct: inserted.delta_pct,
            recommendation_action: inserted.recommendation.action,
          },
          'anomaly inserted',
        );
        // O12 cooldown: 24h per (builder, customer, source_type),
        // overridden when the new severity strictly escalates above the
        // last alert. Skips dispatch only — the row stays persisted so
        // the dashboard surface still shows it.
        const cooled = await isInCooldown({
          builder_id: builderId,
          customer_id: inserted.customer_id,
          source_type: inserted.source_type,
          new_severity: inserted.severity,
          now,
          // Exclude the row we just persisted; otherwise the cooldown
          // query matches it and suppresses the first alert of every
          // new anomaly shape (created_at defaults to now()).
          exclude_anomaly_id: inserted.id,
        });
        if (cooled) {
          log.info(
            { builder_id: builderId, anomaly_id: inserted.id, severity: inserted.severity },
            'anomaly alert dispatch suppressed by 24h cooldown',
          );
          continue;
        }

        // Fire-and-forget: dispatch failure must not stall the cron and
        // must not roll back the persisted row. `deliverBuilderAlert`
        // already swallows channel errors internally; this catch is the
        // outer safety net for unexpected throws (e.g. config lookup).
        try {
          await deliverBuilderAlert({
            builderId,
            payload: buildAnomalyDetectedPayload(builderId, inserted),
          });
          log.info({ builder_id: builderId, anomaly_id: inserted.id }, 'anomaly alert dispatched');
        } catch (err) {
          log.warn(
            {
              builder_id: builderId,
              anomaly_id: inserted.id,
              error: formatError(err),
            },
            'anomaly alert dispatch threw',
          );
        }
      } else {
        summary.skipped_idempotent += 1;
      }
    }
  }

  return summary;
}

function costFor(agg: PeriodAggregates, customerId: string | null): number {
  if (customerId === null) return agg.total_cost_usd;
  return agg.costByCustomer.get(customerId) ?? 0;
}

function slicesFor(agg: PeriodAggregates, customerId: string | null): PeriodSlices {
  if (customerId === null) return agg.all;
  return agg.byCustomer.get(customerId) ?? EMPTY_SLICES;
}
