// B4-4c — margin_protection rule evaluation. Invoked per-builder from the
// hourly detect-anomalies cron (anomaly/runner.detectForBuilder), which
// already provides builder batching, error isolation, and the model-tier
// catalog. Until this module, margin_protection rules could be created and
// activated but were never evaluated by anything.
//
// Per rule:
//   audience   — targeted customer, every priced customer (per_customer),
//                or all priced customers aggregated (pooled). "Priced" =
//                has an open customer_pricing version; only those have
//                computable revenue.
//   cost       — aggregateSpendForRule over the rule's period window
//                (same aggregate the budget paths use).
//   revenue    — applyFormula(active pricing version, ClickHouse usage)
//                — the same math the invoice generator bills with, so a
//                margin alert can never disagree with the invoice.
//   margin_pct — (revenue − cost) / revenue × 100 → detectMarginRisk
//                (WARN, ERROR when negative).
//
// On fire: persist a MARGIN_RISK anomaly row (idempotent per period via
// migration 030's partial unique index), dispatch margin.alert through the
// rule's own channels, dedup dispatch per (rule, customer, period) via
// alert_history (durable across restarts, unlike the post-call in-proc
// map), and stamp rules.last_triggered_at.
//
// Customers without computable revenue take the rule's
// insufficient_revenue_data_treatment: 'skip' (default) counts them
// silently; 'alert' emits ONE summary per rule per period (never one per
// customer — a builder with 400 unpriced customers gets one nudge, not a
// paged-out channel).

import {
  AnomalySeverity,
  AnomalySourceType,
  RulePeriod,
  RuleScope,
  RuleStatus,
  RuleType,
  type AnomalyDiagnosis,
  type Rule,
  type RulePeriod as RulePeriodT,
  type RuleScope as RuleScopeT,
} from '@pylva/shared';
import { and, eq, gte, sql as drizzleSql } from 'drizzle-orm';
import { withRLS } from '../db/rls.js';
import { alertHistory } from '../db/schema.js';
import { logger } from '../logger.js';
import { listRules, listAlertChannelEntriesForRule, markRuleTriggered } from './repository.js';
import { periodStartFor, periodEndFor } from '../budget/period-utils.js';
import { aggregateSpendForRule } from '../budget/aggregate.js';
import { getActiveVersion, rowToCustomerPricing } from '../billing/pricing-versioning.js';
import { getUsageForPeriod } from '../billing/clickhouse-usage.js';
import { applyFormula } from '../billing/formulas.js';
import { detectMarginRisk, type DetectorResult } from '../anomaly/detector.js';
import { diagnoseMargin } from './margin-diagnosis.js';
import { recommendFromDiagnosis, type RecommendationContext } from './recommendations.js';
import { insertAnomalyEvent } from '../anomaly/repository.js';
import {
  fetchPeriodAggregates,
  type PeriodAggregates,
  type PeriodSlices,
} from '../anomaly/clickhouse-queries.js';
import { chTimestamp } from '../clickhouse/datetime.js';
import { toCompositeCustomerId } from '../clickhouse/customer-id.js';
import { deliverAlert } from '../alerts/delivery.js';
import { buildMarginAlertPayload } from '../alerts/payloads.js';
import { buildAnomalyDetectedPayload } from '../alerts/anomaly-payloads.js';
import {
  countCustomers,
  listCustomersWithOpenPricing,
  type PricedCustomerRef,
} from '../customers/lookup.js';

const log = logger.child({ module: 'rules.margin-evaluator' });

// Bound concurrent fan-out while still evaluating the complete audience. A
// fixed audience cap would permanently exclude the same tail customers from
// every hourly run because the source list is ordered by external_id.
const MEMBER_CONCURRENCY = 5;
const PAYLOAD_TOP_DRIVERS = 3;
const EMPTY_SLICES: PeriodSlices = { steps: [], models: [], sources: [] };

export interface MarginEvaluationSummary {
  rules_evaluated: number;
  anomalies_inserted: number;
  anomalies_skipped_idempotent: number;
  alerts_fired: number;
  customers_skipped_insufficient_revenue: number;
}

interface NarrowedMarginConfig {
  margin_threshold_pct: number;
  period: RulePeriodT;
  scope: RuleScopeT;
  treatment: 'skip' | 'alert';
}

interface MemberMeasurement {
  member: PricedCustomerRef;
  cost_usd: number;
  revenue_usd: number;
}

/** Defensive narrowing — margin rows can predate the validator. */
function narrowMarginConfig(rule: Rule): NarrowedMarginConfig | null {
  const cfg = rule.config as {
    margin_threshold_pct?: unknown;
    period?: unknown;
    scope?: unknown;
    insufficient_revenue_data_treatment?: unknown;
  };
  const threshold = cfg.margin_threshold_pct;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)) return null;
  const period = cfg.period;
  if (
    period !== RulePeriod.HOUR &&
    period !== RulePeriod.DAY &&
    period !== RulePeriod.WEEK &&
    period !== RulePeriod.MONTH
  ) {
    return null;
  }
  const scope = cfg.scope === RuleScope.POOLED ? RuleScope.POOLED : RuleScope.PER_CUSTOMER;
  const treatment = cfg.insufficient_revenue_data_treatment === 'alert' ? 'alert' : 'skip';
  return { margin_threshold_pct: threshold, period, scope, treatment };
}

export function marginPct(revenueUsd: number, costUsd: number): number {
  return ((revenueUsd - costUsd) / revenueUsd) * 100;
}

/**
 * Durable dispatch dedup: has this rule already alerted for this
 * (event type, customer, period)? alert_history rows are written by
 * deliverAlert, so this survives process restarts — the post-call
 * evaluator's in-proc map cannot.
 */
async function hasAlertedThisPeriod(opts: {
  builderId: string;
  ruleId: string;
  periodStart: Date;
  eventType: string;
  customerId: string | null;
}): Promise<boolean> {
  const rows = await withRLS(opts.builderId, async (tx) =>
    tx
      .select({ id: alertHistory.id })
      .from(alertHistory)
      .where(
        and(
          eq(alertHistory.builder_id, opts.builderId),
          eq(alertHistory.rule_id, opts.ruleId),
          gte(alertHistory.fired_at, opts.periodStart),
          drizzleSql`${alertHistory.payload}->'payload'->>'type' = ${opts.eventType}`,
          opts.customerId === null
            ? drizzleSql`${alertHistory.payload}->'payload'->'data'->>'customer_id' IS NULL`
            : drizzleSql`${alertHistory.payload}->'payload'->'data'->>'customer_id' = ${opts.customerId}`,
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

export async function evaluateMarginRules(opts: {
  builderId: string;
  catalog: RecommendationContext['catalog'];
  now?: Date;
}): Promise<MarginEvaluationSummary> {
  const now = opts.now ?? new Date();
  const summary: MarginEvaluationSummary = {
    rules_evaluated: 0,
    anomalies_inserted: 0,
    anomalies_skipped_idempotent: 0,
    alerts_fired: 0,
    customers_skipped_insufficient_revenue: 0,
  };

  const marginRules = (await listRules(opts.builderId)).filter(
    (r) => r.type === RuleType.MARGIN_PROTECTION && r.enabled && r.status === RuleStatus.ACTIVE,
  );
  if (marginRules.length === 0) return summary;

  const audience = await listCustomersWithOpenPricing(opts.builderId, now);
  // Current + prior period aggregates for diagnosis slices, fetched at
  // most once per distinct rule period.
  const aggCache = new Map<RulePeriodT, { current: PeriodAggregates; prior: PeriodAggregates }>();

  for (const rule of marginRules) {
    const cfg = narrowMarginConfig(rule);
    if (!cfg) {
      log.warn(
        { builder_id: opts.builderId, rule_id: rule.id },
        'margin rule config is malformed; skipping (edit the rule to re-validate it)',
      );
      continue;
    }
    summary.rules_evaluated += 1;
    try {
      await evaluateOneRule({
        builderId: opts.builderId,
        rule,
        cfg,
        audience,
        catalog: opts.catalog,
        now,
        aggCache,
        summary,
      });
    } catch (err) {
      log.warn(
        {
          builder_id: opts.builderId,
          rule_id: rule.id,
          error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
        },
        'margin rule evaluation failed; other rules continue',
      );
    }
  }

  return summary;
}

async function evaluateOneRule(input: {
  builderId: string;
  rule: Rule;
  cfg: NarrowedMarginConfig;
  audience: PricedCustomerRef[];
  catalog: RecommendationContext['catalog'];
  now: Date;
  aggCache: Map<RulePeriodT, { current: PeriodAggregates; prior: PeriodAggregates }>;
  summary: MarginEvaluationSummary;
}): Promise<void> {
  const { builderId, rule, cfg, catalog, now, summary } = input;
  const from = periodStartFor(cfg.period, now);
  const to = periodEndFor(cfg.period, now);

  // Resolve the rule's audience among priced customers.
  let members: PricedCustomerRef[];
  let unpricedCount = 0;
  if (rule.customer_id) {
    const member = input.audience.find((c) => c.external_id === rule.customer_id);
    members = member ? [member] : [];
    if (!member) unpricedCount += 1;
  } else {
    members = input.audience;
    if (cfg.treatment === 'alert') {
      // Only the summary alert needs the "how many customers have no
      // pricing at all" count; skip the query otherwise.
      const total = await countCustomers(builderId);
      unpricedCount += Math.max(0, total - input.audience.length);
    }
  }
  // Measure every member: revenue via the invoice formula, cost via the
  // shared budget aggregate. Zero/negative revenue is not computable
  // margin — it joins the insufficient count.
  const measured: MemberMeasurement[] = [];
  for (let i = 0; i < members.length; i += MEMBER_CONCURRENCY) {
    const batch = members.slice(i, i + MEMBER_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((member) => measureMember({ builderId, rule, member, from, to, now })),
    );
    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j]!;
      if (outcome.status === 'fulfilled') {
        if (outcome.value) measured.push(outcome.value);
        else unpricedCount += 1;
      } else {
        // Measurement failure (CH/PG hiccup) must not fabricate a margin —
        // treat as not-computable and keep going.
        unpricedCount += 1;
        log.warn(
          {
            builder_id: builderId,
            rule_id: rule.id,
            customer_id: batch[j]?.external_id,
            error:
              outcome.reason instanceof Error
                ? `${outcome.reason.constructor.name}: ${outcome.reason.message}`
                : String(outcome.reason),
          },
          'margin measurement failed for customer',
        );
      }
    }
  }

  let insufficientRevenue = 0;

  if (cfg.scope === RuleScope.POOLED) {
    const revenue = measured.reduce((s, m) => s + m.revenue_usd, 0);
    const cost = measured.reduce((s, m) => s + m.cost_usd, 0);
    if (measured.length > 0 && revenue > 0) {
      const hit = detectMarginRisk({
        current_margin_pct: marginPct(revenue, cost),
        threshold_pct: cfg.margin_threshold_pct,
        cost_usd: cost,
        revenue_usd: revenue,
      });
      if (hit) {
        await fireMarginAlert({
          builderId,
          rule,
          cfg,
          externalCustomerId: null,
          hit,
          costUsd: cost,
          from,
          to,
          now,
          catalog,
          aggCache: input.aggCache,
          summary,
        });
      }
    } else {
      insufficientRevenue += measured.length;
    }
  } else {
    for (const m of measured) {
      if (m.revenue_usd <= 0) {
        insufficientRevenue += 1;
        continue;
      }
      const hit = detectMarginRisk({
        current_margin_pct: marginPct(m.revenue_usd, m.cost_usd),
        threshold_pct: cfg.margin_threshold_pct,
        cost_usd: m.cost_usd,
        revenue_usd: m.revenue_usd,
      });
      if (!hit) continue;
      await fireMarginAlert({
        builderId,
        rule,
        cfg,
        externalCustomerId: m.member.external_id,
        hit,
        costUsd: m.cost_usd,
        from,
        to,
        now,
        catalog,
        aggCache: input.aggCache,
        summary,
      });
    }
  }

  const insufficientTotal = unpricedCount + insufficientRevenue;
  summary.customers_skipped_insufficient_revenue += insufficientTotal;
  if (cfg.treatment === 'alert' && insufficientTotal > 0) {
    await fireInsufficientDataAlert({
      builderId,
      rule,
      insufficientTotal,
      considered: members.length + unpricedCount,
      from,
      to,
      catalog,
      summary,
    });
  }
}

async function measureMember(input: {
  builderId: string;
  rule: Rule;
  member: PricedCustomerRef;
  from: Date;
  to: Date;
  now: Date;
}): Promise<MemberMeasurement | null> {
  const pricingRow = await getActiveVersion({
    builderId: input.builderId,
    customerId: input.member.id,
    at: input.now,
  });
  if (!pricingRow) return null;
  const composite = toCompositeCustomerId(input.builderId, input.member.external_id);
  const [usage, cost] = await Promise.all([
    getUsageForPeriod({
      builderId: input.builderId,
      customerId: composite,
      from: input.from,
      to: input.to,
    }),
    aggregateSpendForRule(input.builderId, input.rule, composite, {
      from: input.from,
      to: input.to,
    }),
  ]);
  const revenue = applyFormula(rowToCustomerPricing(pricingRow), usage).amount_usd;
  return { member: input.member, cost_usd: cost, revenue_usd: revenue };
}

async function periodSlices(input: {
  builderId: string;
  period: RulePeriodT;
  externalCustomerId: string | null;
  now: Date;
  aggCache: Map<RulePeriodT, { current: PeriodAggregates; prior: PeriodAggregates }>;
}): Promise<{ current: PeriodSlices; prior: PeriodSlices }> {
  let aggs = input.aggCache.get(input.period);
  if (!aggs) {
    const from = periodStartFor(input.period, input.now);
    const to = periodEndFor(input.period, input.now);
    // Prior window = the full period immediately before this one; an
    // instant inside the previous period is 1ms before `from`.
    const priorFrom = periodStartFor(input.period, new Date(from.getTime() - 1));
    const [current, prior] = await Promise.all([
      fetchPeriodAggregates(input.builderId, chTimestamp(from), chTimestamp(to)),
      fetchPeriodAggregates(input.builderId, chTimestamp(priorFrom), chTimestamp(from)),
    ]);
    aggs = { current, prior };
    input.aggCache.set(input.period, aggs);
  }
  if (input.externalCustomerId === null) {
    return { current: aggs.current.all, prior: aggs.prior.all };
  }
  const composite = toCompositeCustomerId(input.builderId, input.externalCustomerId);
  return {
    current: aggs.current.byCustomer.get(composite) ?? EMPTY_SLICES,
    prior: aggs.prior.byCustomer.get(composite) ?? EMPTY_SLICES,
  };
}

/** Top current-period cost drivers for the margin.alert payload — the
 *  contract's {label, cost_usd} means "what this driver COST", not the
 *  period-over-period delta the diagnosis tracks. */
function payloadTopDrivers(current: PeriodSlices): Array<{ label: string; cost_usd: number }> {
  return [...current.models]
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, PAYLOAD_TOP_DRIVERS)
    .filter((m) => m.cost_usd > 0)
    .map((m) => ({ label: `${m.provider ?? '?'}/${m.model ?? '?'}`, cost_usd: m.cost_usd }));
}

async function fireMarginAlert(input: {
  builderId: string;
  rule: Rule;
  cfg: NarrowedMarginConfig;
  externalCustomerId: string | null;
  hit: DetectorResult;
  costUsd: number;
  from: Date;
  to: Date;
  now: Date;
  catalog: RecommendationContext['catalog'];
  aggCache: Map<RulePeriodT, { current: PeriodAggregates; prior: PeriodAggregates }>;
  summary: MarginEvaluationSummary;
}): Promise<void> {
  const { builderId, rule, summary } = input;
  const slices = await periodSlices({
    builderId,
    period: input.cfg.period,
    externalCustomerId: input.externalCustomerId,
    now: input.now,
    aggCache: input.aggCache,
  });
  const diagnosis = diagnoseMargin({
    current: slices.current,
    prior: slices.prior,
    has_revenue_data: true,
  });
  const recommendation = recommendFromDiagnosis(diagnosis, {
    catalog: input.catalog,
    customer_id: input.externalCustomerId,
    rule_scope: input.cfg.scope,
    ...(typeof (rule.config as { ab_suggestion_traffic_pct?: number }).ab_suggestion_traffic_pct ===
    'number'
      ? {
          ab_suggestion_traffic_pct: (rule.config as { ab_suggestion_traffic_pct: number })
            .ab_suggestion_traffic_pct,
        }
      : {}),
  });

  const inserted = await insertAnomalyEvent({
    builder_id: builderId,
    customer_id: input.externalCustomerId,
    source_type: AnomalySourceType.MARGIN_RISK,
    severity: input.hit.severity,
    period_start: input.from,
    period_end: input.to,
    actual_value: input.hit.actual_value,
    baseline_value: input.hit.baseline_value,
    delta_pct: input.hit.delta_pct,
    diagnosis,
    recommendation,
  });
  if (inserted) summary.anomalies_inserted += 1;
  else summary.anomalies_skipped_idempotent += 1;

  // Dispatch dedup is separate from the anomaly-row dedup: dismissing the
  // anomaly mid-period lets a fresh row insert, but the builder already
  // got this period's page — don't re-send it.
  const alreadyAlerted = await hasAlertedThisPeriod({
    builderId,
    ruleId: rule.id,
    periodStart: input.from,
    eventType: 'margin.alert',
    customerId: input.externalCustomerId,
  });
  if (alreadyAlerted) return;

  const channels = await listAlertChannelEntriesForRule(builderId, rule.id);
  await deliverAlert({
    builder_id: builderId,
    rule_id: rule.id,
    payload: {
      version: '1.0' as const,
      rule_id: rule.id,
      fired_at: new Date().toISOString(),
      payload: buildMarginAlertPayload(rule, {
        builder_id: builderId,
        customer_id: input.externalCustomerId,
        current_usd: input.costUsd,
        period_start: input.from.toISOString(),
        margin_percent: input.hit.actual_value ?? 0,
        top_drivers: payloadTopDrivers(slices.current),
      }),
    },
    channels,
  });
  await markRuleTriggered(builderId, rule.id);
  summary.alerts_fired += 1;
  log.info(
    {
      builder_id: builderId,
      rule_id: rule.id,
      customer_id: input.externalCustomerId,
      margin_pct: input.hit.actual_value,
      threshold_pct: input.hit.baseline_value,
      severity: input.hit.severity,
      cost_usd: input.costUsd,
    },
    'margin rule fired',
  );
}

async function fireInsufficientDataAlert(input: {
  builderId: string;
  rule: Rule;
  insufficientTotal: number;
  considered: number;
  from: Date;
  to: Date;
  catalog: RecommendationContext['catalog'];
  summary: MarginEvaluationSummary;
}): Promise<void> {
  const { builderId, rule, summary } = input;
  const customerId = rule.customer_id ?? null;
  const diagnosis: AnomalyDiagnosis = {
    insufficient_revenue_data: true,
    notes: [
      `${input.insufficientTotal} of ${input.considered} end-user(s) in this rule's audience have no computable revenue for this period (no pricing configured, or $0 billed). Margin cannot be evaluated for them — configure pricing under Billing → Customer pricing.`,
    ],
  };
  const recommendation = recommendFromDiagnosis(diagnosis, {
    catalog: input.catalog,
    customer_id: customerId,
  });

  const inserted = await insertAnomalyEvent({
    builder_id: builderId,
    customer_id: customerId,
    source_type: AnomalySourceType.MARGIN_RISK,
    severity: AnomalySeverity.WARN,
    period_start: input.from,
    period_end: input.to,
    actual_value: null,
    baseline_value: null,
    delta_pct: null,
    diagnosis,
    recommendation,
  });
  if (inserted) summary.anomalies_inserted += 1;
  else summary.anomalies_skipped_idempotent += 1;
  // No fresh anomaly row → an earlier tick this period already ran this
  // path; the alert_history check below would skip anyway, but don't pay
  // the channel lookup for a known no-op.
  if (!inserted) return;

  const alreadyAlerted = await hasAlertedThisPeriod({
    builderId,
    ruleId: rule.id,
    periodStart: input.from,
    eventType: 'anomaly.detected',
    customerId,
  });
  if (alreadyAlerted) return;

  const channels = await listAlertChannelEntriesForRule(builderId, rule.id);
  await deliverAlert({
    builder_id: builderId,
    rule_id: rule.id,
    payload: {
      version: '1.0' as const,
      rule_id: rule.id,
      fired_at: new Date().toISOString(),
      // anomaly.detected (not margin.alert): the margin.alert wire contract
      // requires a real margin_percent, and there is none to report here.
      payload: buildAnomalyDetectedPayload(builderId, inserted),
    },
    channels,
  });
  summary.alerts_fired += 1;
  log.info(
    {
      builder_id: builderId,
      rule_id: rule.id,
      insufficient: input.insufficientTotal,
      considered: input.considered,
    },
    'margin rule emitted insufficient-revenue-data summary',
  );
}
