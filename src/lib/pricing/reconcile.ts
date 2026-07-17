// Daily ClickHouse projection drift check.
// Compares the canonical mixed event view with legacy aggregates plus the
// deduplicated authoritative projection for the previous day.
// Drift > 0.1% → Pino error + Slack alert.

import { clickhouse } from '../clickhouse/client.js';
import { postSlackAlert } from '../alerts/slack.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'pricing.reconcile' });

export interface ReconcileResult {
  day: string; // YYYY-MM-DD (UTC)
  events_total: number;
  mv_total: number;
  delta: number;
  drift_pct: number;
  alert_fired: boolean;
}

/** Reconcile the MV for a given UTC day (defaults to yesterday). */
export async function runReconcile(dayIso?: string): Promise<ReconcileResult> {
  const day = dayIso ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) {
    throw new TypeError('day must be a UTC calendar date in YYYY-MM-DD format');
  }
  const dayStart = `${day}T00:00:00.000Z`;
  const parsedDayStart = new Date(dayStart);
  if (Number.isNaN(parsedDayStart.getTime()) || parsedDayStart.toISOString() !== dayStart) {
    throw new TypeError('day must be a valid UTC calendar date');
  }
  const nextDayStart = new Date(parsedDayStart.getTime() + 86_400_000).toISOString();

  const eventsRes = await clickhouse.query({
    query: `
      SELECT coalesce(sum(cost_usd), 0) AS total
      FROM cost_events_with_control
      WHERE timestamp >= parseDateTime64BestEffort({day_start:String}, 3, 'UTC')
        AND timestamp < parseDateTime64BestEffort({next_day_start:String}, 3, 'UTC')
    `,
    query_params: { day_start: dayStart, next_day_start: nextDayStart },
    format: 'JSONEachRow',
  });
  const [eventsRow] = (await eventsRes.json()) as Array<{ total: number | string }>;
  const eventsTotal = Number(eventsRow?.total ?? 0);

  const mvRes = await clickhouse.query({
    query: `
      SELECT coalesce(sum(total), 0) AS total
      FROM (
        SELECT coalesce(sum(total_cost_usd), 0) AS total
        FROM cost_daily_agg_v2
        WHERE day = toDate(parseDateTime64BestEffort({day_start:String}, 3, 'UTC'), 'UTC')
        UNION ALL
        SELECT coalesce(sum(cost_usd), 0) AS total
        FROM budget_cost_events_final
        WHERE payload_hash_count = 1
          AND timestamp >= parseDateTime64BestEffort({day_start:String}, 3, 'UTC')
          AND timestamp < parseDateTime64BestEffort({next_day_start:String}, 3, 'UTC')
      )
    `,
    query_params: { day_start: dayStart, next_day_start: nextDayStart },
    format: 'JSONEachRow',
  });
  const [mvRow] = (await mvRes.json()) as Array<{ total: number | string }>;
  const mvTotal = Number(mvRow?.total ?? 0);

  const delta = Math.abs(eventsTotal - mvTotal);
  const driftPct = eventsTotal === 0 ? 0 : delta / Math.abs(eventsTotal);

  let alertFired = false;
  if (driftPct > 0.001) {
    alertFired = true;
    log.error(
      { day, events_total: eventsTotal, mv_total: mvTotal, delta, drift_pct: driftPct },
      'cost_daily_agg_v2 drift detected',
    );
    await postSlackAlert(
      `Pylva: cost_daily_agg_v2 drift on ${day}: events=${eventsTotal}, mv=${mvTotal}, delta=${delta}, drift=${(driftPct * 100).toFixed(4)}%`,
    );
  } else {
    log.info(
      { day, events_total: eventsTotal, mv_total: mvTotal, drift_pct: driftPct },
      'reconciliation clean',
    );
  }

  return {
    day,
    events_total: eventsTotal,
    mv_total: mvTotal,
    delta,
    drift_pct: driftPct,
    alert_fired: alertFired,
  };
}
