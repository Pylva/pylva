// B4-4 margin / spend diagnosis. Pure deterministic logic — no I/O. The
// caller (B4-4b cron) fetches period-aggregated data + the customer's
// pricing config and feeds them in. Output is the structured
// `AnomalyDiagnosis` shape from `@pylva/shared`; downstream alert
// templates render the JSON without LLM-generated text (D10).
//
// Heuristics: top-3 absolute spend deltas, iteration inflation,
// insufficient_revenue_data flag. Margin-threshold logic (when revenue
// data is present) lives in B4-4b — this module just describes WHAT
// changed; the cron decides if it warrants an anomaly_event.

import { DriverKind, type AnomalyDiagnosis, type AnomalyDriver } from '@pylva/shared';

const TOP_DRIVERS_LIMIT = 3;

// `\0` is forbidden by the telemetry step_name / model regex
// (`packages/shared/src/types/telemetry.ts`), so it's a collision-proof
// sentinel for "this slice's name is null." Using a string like
// `'__null__'` would clash with a real customer naming convention.
const NULL_KEY = '\0';

export interface PeriodSlice {
  /** USD spent in this slice during the measurement period. */
  cost_usd: number;
}

export interface SteppedSlice extends PeriodSlice {
  step_name: string | null;
  /** Total events / iterations the step ran during the period. */
  iterations: number;
}

export interface ModeledSlice extends PeriodSlice {
  /** Provider id ('openai', 'anthropic', etc.) — null when unknown. */
  provider: string | null;
  model: string | null;
}

export interface SourcedSlice extends PeriodSlice {
  /** Cost-source bucket: 'auto' (priced by ingest) vs 'configured'
   *  (custom pricing) vs 'reported' (non-LLM via report_usage). */
  source: string | null;
}

export interface MarginDiagnosisInput {
  /** Same-shape slices for the current and prior measurement periods.
   *  Caller picks the period definition (day/week/month) and supplies
   *  matching prior-period data so deltas are comparable. */
  current: {
    steps: SteppedSlice[];
    models: ModeledSlice[];
    sources: SourcedSlice[];
  };
  prior: {
    steps: SteppedSlice[];
    models: ModeledSlice[];
    sources: SourcedSlice[];
  };
  /** Pass `false` when the customer has no pricing config in
   *  customer_pricing — diagnosis flips to insufficient_revenue_data. */
  has_revenue_data: boolean;
}

interface DriverWorkRow<T extends PeriodSlice> {
  key: string;
  delta_usd: number;
  current?: T;
  prior?: T;
}

function diffByKey<T extends PeriodSlice>(
  current: T[],
  prior: T[],
  key: (slice: T) => string,
): DriverWorkRow<T>[] {
  const rows = new Map<string, DriverWorkRow<T>>();
  for (const slice of prior) {
    const k = key(slice);
    rows.set(k, { key: k, delta_usd: -slice.cost_usd, prior: slice });
  }
  for (const slice of current) {
    const k = key(slice);
    const existing = rows.get(k);
    if (existing) {
      existing.delta_usd += slice.cost_usd;
      existing.current = slice;
    } else {
      rows.set(k, { key: k, delta_usd: slice.cost_usd, current: slice });
    }
  }
  return [...rows.values()].filter((r) => r.delta_usd !== 0);
}

function detectIterationInflation(
  current: SteppedSlice[],
  prior: SteppedSlice[],
): AnomalyDiagnosis['iteration_inflation'] | undefined {
  // D10: flag the FIRST step with strict iteration growth — let the
  // builder decide whether it's intentional. Schema is single-shape
  // so we surface only the largest growth ratio per cron run; the cron
  // emits at most one anomaly per (builder, customer, type, period),
  // so multi-step inflation surfaces over successive runs.
  const priorByStep = new Map<string | null, number>();
  for (const slice of prior) priorByStep.set(slice.step_name, slice.iterations);

  let best: { step: string; from: number; to: number; ratio: number } | null = null;
  for (const slice of current) {
    if (slice.step_name == null) continue;
    const before = priorByStep.get(slice.step_name) ?? 0;
    if (before === 0) continue; // brand-new step — not iteration inflation
    if (slice.iterations <= before) continue;
    const ratio = slice.iterations / before;
    if (best == null || ratio > best.ratio) {
      best = {
        step: slice.step_name,
        from: before,
        to: slice.iterations,
        ratio,
      };
    }
  }
  return best ? { step_name: best.step, from: best.from, to: best.to } : undefined;
}

export function diagnoseMargin(input: MarginDiagnosisInput): AnomalyDiagnosis {
  const out: AnomalyDiagnosis = {};

  if (!input.has_revenue_data) {
    out.insufficient_revenue_data = true;
  }

  const stepRows = diffByKey(
    input.current.steps,
    input.prior.steps,
    (s) => s.step_name ?? NULL_KEY,
  );
  const modelRows = diffByKey(
    input.current.models,
    input.prior.models,
    (m) => `${m.provider ?? NULL_KEY}\0${m.model ?? NULL_KEY}`,
  );
  const sourceRows = diffByKey(
    input.current.sources,
    input.prior.sources,
    (s) => s.source ?? NULL_KEY,
  );

  const candidates: AnomalyDriver[] = [];
  for (const r of stepRows) {
    const slice = r.current ?? r.prior!;
    candidates.push({
      kind: DriverKind.STEP,
      label: slice.step_name ?? '(none)',
      delta_usd: r.delta_usd,
    });
  }
  for (const r of modelRows) {
    const slice = r.current ?? r.prior!;
    candidates.push({
      kind: DriverKind.MODEL,
      label: `${slice.provider ?? '?'}/${slice.model ?? '?'}`,
      delta_usd: r.delta_usd,
      ...(slice.provider ? { provider: slice.provider } : {}),
      ...(slice.model ? { model: slice.model } : {}),
    });
  }
  for (const r of sourceRows) {
    const slice = r.current ?? r.prior!;
    candidates.push({
      kind: DriverKind.SOURCE,
      label: slice.source ?? '(unknown)',
      delta_usd: r.delta_usd,
    });
  }

  candidates.sort((a, b) => Math.abs(b.delta_usd) - Math.abs(a.delta_usd));
  const top = candidates.slice(0, TOP_DRIVERS_LIMIT);
  if (top.length > 0) out.top_drivers = top;

  const iter = detectIterationInflation(input.current.steps, input.prior.steps);
  if (iter) out.iteration_inflation = iter;

  return out;
}
