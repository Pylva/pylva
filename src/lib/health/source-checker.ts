// Adaptive silence + 7d/30d cost-drop detection for cost_sources rows.
// Runs hourly from /api/cron/health-check (b3 plan §9, D31/D32).
//
// Adaptive silence: skip sources with <14 days of distinct event-days
// (cold-start). Otherwise alert when current silence exceeds 2x the longest
// historical gap — this self-tunes to weekday-only / batch / seasonal
// patterns without configuration. A 72h absolute ceiling backstops sources
// whose history is dense enough that 2x is unreasonably long.
//
// Cost drop: 7-day rolling average vs 30-day rolling average of cost_usd.
// Alert when 7d falls below 10% of 30d (a >90% drop). Smooths post-deploy
// spikes-then-normal so spikes don't trigger drop alerts on the back-half.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const LOOKBACK_DAYS = 30;
const COLD_START_MIN_EVENT_DAYS = 14;
const ABSOLUTE_SILENCE_CEILING_HOURS = 72;
const SILENCE_GAP_MULTIPLIER = 2;
const COST_DROP_RATIO = 0.1;

export interface DailyEventRow {
  day: string;
  event_count: number;
  cost_usd: number;
}

export interface SilenceFinding {
  silent_hours: number;
  longest_historical_gap_hours: number;
  reason: 'gap_exceeded' | 'absolute_ceiling';
}

export interface CostDropFinding {
  rolling_7d_avg_usd: number;
  rolling_30d_avg_usd: number;
  drop_percent: number;
}

export interface SourceHealthEvaluation {
  silence: SilenceFinding | null;
  cost_drop: CostDropFinding | null;
  cold_start: boolean;
}

/**
 * Pure evaluator. Decoupled from I/O so it can be unit-tested without a DB.
 * `daily` MUST be sorted ascending by day.
 */
export function evaluateSourceHealth(
  daily: DailyEventRow[],
  lastSeenAt: Date | null,
  now: Date,
): SourceHealthEvaluation {
  const eventDays = daily.filter((d) => d.event_count > 0);
  if (eventDays.length < COLD_START_MIN_EVENT_DAYS) {
    return { silence: null, cost_drop: null, cold_start: true };
  }

  const silence = lastSeenAt ? detectSilence(eventDays, lastSeenAt, now) : null;
  const cost_drop = detectCostDrop(daily, now);

  return { silence, cost_drop, cold_start: false };
}

function detectSilence(
  eventDays: DailyEventRow[],
  lastSeenAt: Date,
  now: Date,
): SilenceFinding | null {
  const sortedDays = eventDays.map((d) => Date.parse(`${d.day}T00:00:00Z`)).sort((a, b) => a - b);

  let longestGapMs = 0;
  for (let i = 1; i < sortedDays.length; i++) {
    const gap = sortedDays[i]! - sortedDays[i - 1]!;
    if (gap > longestGapMs) longestGapMs = gap;
  }

  const silentMs = now.getTime() - lastSeenAt.getTime();
  const silentHours = silentMs / (60 * 60 * 1000);
  const longestGapHours = longestGapMs / (60 * 60 * 1000);

  if (silentHours > ABSOLUTE_SILENCE_CEILING_HOURS) {
    return {
      silent_hours: round1(silentHours),
      longest_historical_gap_hours: round1(longestGapHours),
      reason: 'absolute_ceiling',
    };
  }

  if (silentMs > SILENCE_GAP_MULTIPLIER * longestGapMs && longestGapMs > 0) {
    return {
      silent_hours: round1(silentHours),
      longest_historical_gap_hours: round1(longestGapHours),
      reason: 'gap_exceeded',
    };
  }

  return null;
}

function detectCostDrop(daily: DailyEventRow[], now: Date): CostDropFinding | null {
  const cutoff7 = now.getTime() - 7 * DAY_MS;
  const cutoff30 = now.getTime() - 30 * DAY_MS;

  let sum7 = 0;
  let count7 = 0;
  let sum30 = 0;
  let count30 = 0;

  for (const row of daily) {
    const ts = Date.parse(`${row.day}T00:00:00Z`);
    if (ts >= cutoff30) {
      sum30 += row.cost_usd;
      count30 += 1;
      if (ts >= cutoff7) {
        sum7 += row.cost_usd;
        count7 += 1;
      }
    }
  }

  if (count30 === 0 || count7 === 0) return null;

  const avg30 = sum30 / count30;
  const avg7 = sum7 / count7;
  if (avg30 <= 0) return null;
  if (avg7 >= COST_DROP_RATIO * avg30) return null;

  const dropPercent = ((avg30 - avg7) / avg30) * 100;
  return {
    rolling_7d_avg_usd: round4(avg7),
    rolling_30d_avg_usd: round4(avg30),
    drop_percent: round1(dropPercent),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
