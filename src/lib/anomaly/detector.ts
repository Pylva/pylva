// Pure detector functions over period-aggregated cost data. Each returns
// a `DetectorResult` or null. The orchestrator owns I/O and idempotency;
// this module is intentionally pure (parity with rules/margin-diagnosis).
//
// Result shape mirrors anomaly_events columns
// (actual_value / baseline_value / delta_pct) so the orchestrator can
// pass results straight through to the repository.

import { AnomalySeverity, type AnomalySeverity as AnomalySeverityType } from '@pylva/shared';

const COST_SPIKE_FACTOR = 1.15; // current > 1.15 × baseline
const COST_DROP_FACTOR = 0.1; // current < 0.10 × baseline
const DEPLOY_DROP_FACTOR = 0.1; // 90% drop = current < 10% of baseline
const DEPLOY_WINDOW_HOURS = 24;

export interface DetectorResult {
  severity: AnomalySeverityType;
  actual_value: number;
  baseline_value: number;
  /** Signed percent delta vs baseline; positive = increase, negative =
   *  drop. Useful in alert templates to phrase the change naturally. */
  delta_pct: number;
}

function deltaPct(current: number, baseline: number): number {
  if (baseline === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - baseline) / baseline) * 10_000) / 100;
}

/**
 * Cost spike: current period > 1.15 × 30-day rolling baseline. Baseline
 * is computed by the caller (avg of the last 30 daily slices) so this
 * function can stay pure.
 */
export function detectCostSpike(currentUsd: number, baselineUsd: number): DetectorResult | null {
  if (baselineUsd <= 0) return null;
  if (currentUsd <= COST_SPIKE_FACTOR * baselineUsd) return null;
  return {
    severity: currentUsd > 2 * baselineUsd ? AnomalySeverity.ERROR : AnomalySeverity.WARN,
    actual_value: currentUsd,
    baseline_value: baselineUsd,
    delta_pct: deltaPct(currentUsd, baselineUsd),
  };
}

/**
 * Cost drop: current period < 10% of 30-day baseline (>90% drop). A
 * complete absence (`currentUsd === 0`) still fires when the baseline is
 * non-trivial — that's the silent-instrumentation case the operator
 * needs to see immediately.
 */
export function detectCostDrop(currentUsd: number, baselineUsd: number): DetectorResult | null {
  if (baselineUsd <= 0) return null;
  if (currentUsd >= COST_DROP_FACTOR * baselineUsd) return null;
  return {
    severity: AnomalySeverity.WARN,
    actual_value: currentUsd,
    baseline_value: baselineUsd,
    delta_pct: deltaPct(currentUsd, baselineUsd),
  };
}

export interface DeployDropInput {
  /** USD spent since the most recent `pylva validate --ci` signal. */
  postDeployUsd: number;
  /** USD spent in the equivalent window before the deploy. */
  preDeployUsd: number;
  /** Hours between deploy signal and `now`. Returns null if the signal is
   *  older than the configured window — operator already had a chance to
   *  see the anomaly the previous run. */
  hoursSinceDeploy: number;
}

export function detectDeployDrop(input: DeployDropInput): DetectorResult | null {
  if (input.hoursSinceDeploy > DEPLOY_WINDOW_HOURS) return null;
  if (input.preDeployUsd <= 0) return null; // nothing to compare against
  if (input.postDeployUsd >= DEPLOY_DROP_FACTOR * input.preDeployUsd) return null;
  return {
    severity: AnomalySeverity.ERROR, // deploy-correlated drops are critical
    actual_value: input.postDeployUsd,
    baseline_value: input.preDeployUsd,
    delta_pct: deltaPct(input.postDeployUsd, input.preDeployUsd),
  };
}

export interface SourceSilenceInput {
  source: string;
  last_seen: Date;
  events_last_24h: number;
  /** Median historical inter-event gap in ms — used to decide what
   *  "silent" means for this source. The runner derives it from the
   *  source's last_seen rolling window. */
  expected_gap_ms: number;
}

/**
 * Source silence: current gap > 2 × expected_gap_ms AND no events in
 * the last 24h. The double gate prevents false positives on bursty
 * sources whose median gap is small but legitimately quiet for a few
 * hours overnight.
 */
export function detectSourceSilence(input: SourceSilenceInput, now: Date): DetectorResult | null {
  if (input.expected_gap_ms <= 0) return null;
  if (input.events_last_24h > 0) return null;
  const actualGap = now.getTime() - input.last_seen.getTime();
  if (actualGap < 2 * input.expected_gap_ms) return null;
  return {
    severity: AnomalySeverity.WARN,
    actual_value: actualGap,
    baseline_value: input.expected_gap_ms,
    delta_pct: deltaPct(actualGap, input.expected_gap_ms),
  };
}

export interface MarginRiskInput {
  /** Realized margin in the current period: (revenue - cost) / revenue × 100. */
  current_margin_pct: number;
  /** Threshold from MarginProtectionConfig.margin_threshold_pct (0-100). */
  threshold_pct: number;
  /** Cost in the current period — surfaces in alert templates so the
   *  builder doesn't need to cross-reference the dashboard. */
  cost_usd: number;
  revenue_usd: number;
}

export function detectMarginRisk(input: MarginRiskInput): DetectorResult | null {
  if (input.revenue_usd <= 0) return null;
  if (input.current_margin_pct >= input.threshold_pct) return null;
  return {
    // Margin under 0% means the builder is paying to serve the
    // customer; severity bumps to ERROR so alert templates can route to
    // the on-call channel rather than the digest.
    severity: input.current_margin_pct < 0 ? AnomalySeverity.ERROR : AnomalySeverity.WARN,
    actual_value: input.current_margin_pct,
    baseline_value: input.threshold_pct,
    delta_pct: input.current_margin_pct - input.threshold_pct,
  };
}
