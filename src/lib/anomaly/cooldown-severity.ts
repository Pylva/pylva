// Pure severity-comparison logic for the 24h anomaly dispatch cooldown.
// Kept dependency-free (no DB / config imports) so it can be unit-tested
// without a live Postgres or a validated env.

import { AnomalySeverity, type AnomalySeverity as AnomalySeverityType } from '@pylva/shared';

// Severity ordering: info < warn < error.
export const SEVERITY_RANK: Record<AnomalySeverityType, number> = {
  [AnomalySeverity.INFO]: 0,
  [AnomalySeverity.WARN]: 1,
  [AnomalySeverity.ERROR]: 2,
};

/**
 * Pure cooldown decision. Given the severities of PRIOR anomalies in the
 * 24h window and the new anomaly's severity, returns true when dispatch
 * should be suppressed.
 *
 * The new alert is let through only when it strictly escalates above the
 * highest severity already surfaced in the window, not merely the most
 * recent row. Comparing against the most-recent row let an intervening
 * lower-severity anomaly re-open the escalation gate: ERROR -> WARN -> ERROR
 * inside 24h would re-page at ERROR even though an ERROR alert had already
 * fired inside the window. Because the highest-severity row in a window is
 * always itself dispatched, "max severity in window" is the same baseline as
 * the cooldown contract's "last alert".
 */
export function isSeverityCooledDown(
  priorSeverities: AnomalySeverityType[],
  newSeverity: AnomalySeverityType,
): boolean {
  if (priorSeverities.length === 0) return false;
  const newRank = SEVERITY_RANK[newSeverity] ?? 0;
  let maxPriorRank = -1;
  for (const severity of priorSeverities) {
    const rank = SEVERITY_RANK[severity] ?? 0;
    if (rank > maxPriorRank) maxPriorRank = rank;
  }
  return newRank <= maxPriorRank;
}
