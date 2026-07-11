// Anomaly repository. Idempotent INSERT into `anomaly_events` gated by
// the partial-unique index from migration 030 (NULLS NOT DISTINCT on
// builder/customer/source_type/period_start/period_end WHERE
// status='open'). Returns null when an open anomaly already exists for
// the shape so callers treat it as "skip", not error.

import { and, desc, eq, gte, isNull, ne, or, sql as drizzleSql } from 'drizzle-orm';
import {
  AnomalyRecommendationAction,
  AnomalyStatus,
  AnomalySeverity,
  type AnomalyDiagnosis,
  type AnomalyEvent,
  type AnomalyRecommendation,
  type AnomalySourceType,
  type AnomalySeverity as AnomalySeverityType,
  type AnomalyStatus as AnomalyStatusType,
} from '@pylva/shared';
import { anomalyEvents } from '../db/schema.js';
import { withRLS } from '../db/rls.js';
import { unwrapRows } from '../db/query-utils.js';
import { isSeverityCooledDown } from './cooldown-severity.js';

export interface InsertAnomalyEventInput {
  builder_id: string;
  customer_id: string | null;
  source_type: AnomalySourceType;
  severity?: AnomalySeverityType;
  period_start: Date;
  period_end: Date;
  actual_value?: number | null;
  baseline_value?: number | null;
  delta_pct?: number | null;
  diagnosis: AnomalyDiagnosis;
  recommendation: AnomalyRecommendation;
}

/**
 * Inserts a new OPEN anomaly. Returns the inserted row, or `null` when
 * the partial unique index rejects the row because an open anomaly with
 * the same (builder, customer, source_type, period) already exists.
 */
export async function insertAnomalyEvent(
  input: InsertAnomalyEventInput,
): Promise<AnomalyEvent | null> {
  const inserted = await withRLS(input.builder_id, async (tx) => {
    const rows = await tx
      .insert(anomalyEvents)
      .values({
        builder_id: input.builder_id,
        customer_id: input.customer_id,
        source_type: input.source_type,
        status: AnomalyStatus.OPEN,
        severity: input.severity ?? AnomalySeverity.WARN,
        period_start: input.period_start,
        period_end: input.period_end,
        actual_value: input.actual_value != null ? String(input.actual_value) : null,
        baseline_value: input.baseline_value != null ? String(input.baseline_value) : null,
        delta_pct: input.delta_pct != null ? String(input.delta_pct) : null,
        diagnosis: input.diagnosis,
        recommendation: input.recommendation,
      })
      // Bare ON CONFLICT DO NOTHING swallows any unique violation; the
      // partial unique index from migration 030 is the only constraint
      // that can fire here, so the contract reduces to "if an open
      // anomaly already exists for this (builder, customer, type,
      // period), keep it instead of inserting a second one." Drizzle's
      // typed ON CONFLICT API can't yet restate a partial-index
      // predicate, which is the same workaround idempotency.ts uses.
      .onConflictDoNothing()
      .returning();
    return rows[0] ?? null;
  });
  return inserted ? mapRow(inserted) : null;
}

export async function findOpenAnomaly(
  builderId: string,
  customerId: string | null,
  sourceType: AnomalySourceType,
  periodStart: Date,
  periodEnd: Date,
): Promise<AnomalyEvent | null> {
  const row = await withRLS(builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(anomalyEvents)
      .where(
        and(
          eq(anomalyEvents.builder_id, builderId),
          customerId === null
            ? isNull(anomalyEvents.customer_id)
            : eq(anomalyEvents.customer_id, customerId),
          eq(anomalyEvents.source_type, sourceType),
          eq(anomalyEvents.period_start, periodStart),
          eq(anomalyEvents.period_end, periodEnd),
          eq(anomalyEvents.status, AnomalyStatus.OPEN),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
  return row ? mapRow(row) : null;
}

export interface ListAnomaliesOptions {
  status?: AnomalyStatusType;
  /** When set, returns only this customer's anomalies (and builder-level
   *  ones — `customer_id IS NULL`). Useful for the per-customer dashboard
   *  drill-down. Omit for the full builder feed. */
  customerId?: string | null;
  limit?: number;
}

export async function listAnomalies(
  builderId: string,
  opts: ListAnomaliesOptions = {},
): Promise<AnomalyEvent[]> {
  const { status = AnomalyStatus.OPEN, limit = 50 } = opts;
  const conditions = [eq(anomalyEvents.builder_id, builderId), eq(anomalyEvents.status, status)];
  if (opts.customerId === null) {
    conditions.push(isNull(anomalyEvents.customer_id));
  } else if (typeof opts.customerId === 'string') {
    // bug_002: customerId='X' must include builder-level rows
    // (customer_id IS NULL) too — they're the cron's builder-wide
    // anomalies that affect THIS customer alongside others. Restricting
    // to `eq` only would silently hide every builder-level anomaly
    // from the per-customer drill-down, the exact opposite of the
    // documented contract above ("…and builder-level ones").
    conditions.push(
      or(eq(anomalyEvents.customer_id, opts.customerId), isNull(anomalyEvents.customer_id))!,
    );
  }
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select()
      .from(anomalyEvents)
      .where(and(...conditions))
      .orderBy(desc(anomalyEvents.created_at))
      .limit(limit),
  );
  return rows.map(mapRow);
}

export async function getAnomalyById(
  builderId: string,
  anomalyId: string,
): Promise<AnomalyEvent | null> {
  const row = await withRLS(builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(anomalyEvents)
      .where(and(eq(anomalyEvents.id, anomalyId), eq(anomalyEvents.builder_id, builderId)))
      .limit(1);
    return rows[0] ?? null;
  });
  return row ? mapRow(row) : null;
}

export async function updateAnomalyStatus(
  builderId: string,
  anomalyId: string,
  nextStatus: (typeof AnomalyStatus)[keyof typeof AnomalyStatus],
): Promise<AnomalyEvent | null> {
  const updated = await withRLS(builderId, async (tx) => {
    const setClause: Record<string, unknown> = { status: nextStatus };
    if (nextStatus === AnomalyStatus.DISMISSED) setClause['dismissed_at'] = new Date();
    const rows = await tx
      .update(anomalyEvents)
      .set(setClause)
      .where(and(eq(anomalyEvents.id, anomalyId), eq(anomalyEvents.builder_id, builderId)))
      .returning();
    return rows[0] ?? null;
  });
  return updated ? mapRow(updated) : null;
}

function mapRow(r: typeof anomalyEvents.$inferSelect): AnomalyEvent {
  return {
    id: r.id,
    builder_id: r.builder_id,
    customer_id: r.customer_id,
    source_type: r.source_type as AnomalySourceType,
    status: r.status as AnomalyStatusType,
    severity: r.severity as AnomalySeverityType,
    period_start: r.period_start,
    period_end: r.period_end,
    actual_value: r.actual_value != null ? Number(r.actual_value) : null,
    baseline_value: r.baseline_value != null ? Number(r.baseline_value) : null,
    delta_pct: r.delta_pct != null ? Number(r.delta_pct) : null,
    diagnosis: (r.diagnosis as AnomalyDiagnosis) ?? {},
    recommendation: (r.recommendation as AnomalyRecommendation) ?? {
      action: AnomalyRecommendationAction.DISMISS,
    },
    created_at: r.created_at,
    dismissed_at: r.dismissed_at,
  };
}

// Track 3 PR 3.5 (O12): cooldown helper. Returns true when a recent
// (<24h) anomaly with the same (builder, customer, source_type) exists
// AND the new severity is NOT a 2× escalation. Caller skips alert
// dispatch when this returns true.
//
// Severity ordering: info < warn < error. "2× severity override" reads
// as: only let the alert through if it strictly escalates above the
// highest severity already surfaced in the window (warn → error or
// info → warn|error). Two consecutive 'warn's within 24h are deduped, and
// so is an ERROR that follows an earlier ERROR even with an intervening
// WARN. See `isSeverityCooledDown` for the rationale.
//
// exclude_anomaly_id MUST be set to the row the caller just inserted.
// The runner persists the anomaly *before* checking cooldown, and
// `created_at` defaults to now(), so without this exclusion the cooldown
// query matches the brand-new row itself: same severity -> not a strict
// escalation -> cooldown returns true -> the FIRST alert of every new
// anomaly shape is silently suppressed (it never reaches dispatch).
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface CooldownInput {
  builder_id: string;
  customer_id: string | null;
  source_type: AnomalySourceType;
  new_severity: AnomalySeverityType;
  now?: Date;
  /** Anomaly row to exclude from the cooldown lookup -- set this to the
   *  row the caller just inserted so the dedup compares against PRIOR
   *  anomalies only, not the new one. See header note. */
  exclude_anomaly_id?: string;
}

export async function isInCooldown(input: CooldownInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - COOLDOWN_MS);

  // Fetch every prior anomaly in the 24h window, not just the most recent:
  // the escalation gate must compare against the highest severity already
  // surfaced in the window.
  const rows = await withRLS(input.builder_id, async (tx) =>
    tx
      .select({ severity: anomalyEvents.severity })
      .from(anomalyEvents)
      .where(
        and(
          eq(anomalyEvents.builder_id, input.builder_id),
          input.customer_id === null
            ? isNull(anomalyEvents.customer_id)
            : eq(anomalyEvents.customer_id, input.customer_id),
          eq(anomalyEvents.source_type, input.source_type),
          gte(anomalyEvents.created_at, cutoff),
          input.exclude_anomaly_id ? ne(anomalyEvents.id, input.exclude_anomaly_id) : undefined,
        ),
      ),
  );

  return isSeverityCooledDown(
    rows.map((row) => row.severity as AnomalySeverityType),
    input.new_severity,
  );
}

// Track 3 PR 3.5 (O22): mark open anomalies older than 30 days as
// expired. Cron-callable; idempotent. The next detect-anomalies cycle
// re-creates if the underlying condition still holds.
const EXPIRY_DAYS = 30;

export async function expireStaleAnomalies(now?: Date): Promise<number> {
  // ISO string, not Date: raw db.execute (postgres.js unsafe()) rejects
  // Date params — the sweep failed on every tick and the caller's
  // non-fatal catch reduced it to a warning, so stale anomalies never
  // expired.
  const cutoff = new Date(
    (now ?? new Date()).getTime() - EXPIRY_DAYS * 86_400_000,
  ).toISOString();
  // No RLS — cross-tenant cron sweep.
  const { db } = await import('../db/client.js');
  const result = await db.execute(drizzleSql`
    UPDATE anomaly_events
    SET status = 'expired'
    WHERE status = 'open' AND created_at < ${cutoff}
    RETURNING id
  `);
  // postgres-js returns a Result that `extends Array`, not `{ rows }` — see
  // unwrapRows. Reading `.rows.length` threw every run; the UPDATE still ran,
  // but the throw was swallowed by the caller's non-fatal try/catch so the
  // expired count was lost and a spurious warning logged on each tick.
  return unwrapRows(result).length;
}
