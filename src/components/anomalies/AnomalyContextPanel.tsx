// Server component. Renders an anomaly's diagnosis + recommendation +
// activation-time delta inline above the cost dashboard's KPI grid.
//
// The component is opt-in: the parent page only mounts it when the
// `?anomaly` query string is present (typically arrived via an alert
// deep-link or the recommendations row's "Investigate" button). The
// fresh metric is computed server-side here so the dialog renders in
// one round-trip and the operator sees the activation-time delta
// immediately on page load.

import { AnomalyRecommendationAction, type AnomalyEvent } from '@pylva/shared';
import { getAnomalyById } from '@/lib/anomaly/repository';
import { fetchPeriodAggregates, costForExternalCustomer } from '@/lib/anomaly/clickhouse-queries';
import { chTimestamp } from '@/lib/clickhouse/datetime';
import { AnomalyActionButtons } from './AnomalyActionButtons';

interface Props {
  builderId: string;
  slug: string;
  anomalyId: string;
}

export async function AnomalyContextPanel({
  builderId,
  slug,
  anomalyId,
}: Props): Promise<React.ReactElement | null> {
  const anomaly = await getAnomalyById(builderId, anomalyId);
  if (!anomaly) return null;

  const delta = await computeActivationDelta(builderId, anomaly);
  const sinceCreated = humanizeAge(Date.now() - anomaly.created_at.getTime());

  return (
    <section className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-800">
            Anomaly · {anomaly.source_type.replace(/_/g, ' ')} · {anomaly.severity}
          </div>
          <h2 className="mt-1 text-base font-semibold">
            {anomaly.customer_id ? `Customer ${anomaly.customer_id}` : 'Builder-level'}
            {' · '}
            {sinceCreated} ago
          </h2>
        </div>
        {anomaly.status === 'open' ? (
          <AnomalyActionButtons anomaly={anomaly} slug={slug} />
        ) : (
          <span className="rounded-full bg-[color:var(--muted)] px-2 py-0.5 text-xs">
            {anomaly.status.replace(/_/g, ' ')}
          </span>
        )}
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <Stat label="Period actual" value={fmt(anomaly.actual_value)} />
        <Stat label="Baseline" value={fmt(anomaly.baseline_value)} />
        <Stat
          label="Delta"
          value={
            anomaly.delta_pct != null
              ? `${anomaly.delta_pct >= 0 ? '+' : ''}${anomaly.delta_pct}%`
              : '—'
          }
        />
        <Stat label="Current period" value={fmt(delta.current_value)} />
        <Stat
          label="Activation delta"
          value={
            delta.delta_pct != null
              ? `${delta.delta_pct >= 0 ? '+' : ''}${delta.delta_pct}% vs baseline period`
              : '—'
          }
        />
      </dl>

      {anomaly.diagnosis.top_drivers && anomaly.diagnosis.top_drivers.length > 0 ? (
        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-amber-800">
            Top drivers
          </div>
          <ul className="mt-1 space-y-1 text-sm">
            {anomaly.diagnosis.top_drivers.map((d, i) => (
              <li key={i}>
                <span className="font-medium">{d.label}</span>
                <span className="ml-2 tabular-nums text-[color:var(--muted-foreground)]">
                  {d.delta_usd >= 0 ? '+' : ''}${d.delta_usd.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {anomaly.recommendation.ab_suggestion ? (
        <p className="mt-4 text-sm text-amber-900">
          {anomaly.recommendation.ab_suggestion.rationale}
        </p>
      ) : null}

      {anomaly.diagnosis.iteration_inflation ? (
        <p className="mt-2 text-xs text-amber-900">
          Iteration inflation: step{' '}
          <code className="rounded bg-amber-100 px-1 text-xs">
            {anomaly.diagnosis.iteration_inflation.step_name}
          </code>{' '}
          went from {anomaly.diagnosis.iteration_inflation.from} to{' '}
          {anomaly.diagnosis.iteration_inflation.to} runs/period.
        </p>
      ) : null}

      {anomaly.diagnosis.insufficient_revenue_data ? (
        <p className="mt-2 text-xs text-amber-900">
          Customer pricing not configured — margin diagnosis is partial.
        </p>
      ) : null}

      {anomaly.recommendation.action !== AnomalyRecommendationAction.DISMISS ? (
        <p className="mt-3 text-xs text-amber-900">
          Recommendation: {anomaly.recommendation.action.replace(/_/g, ' ')} (
          {anomaly.recommendation.action ===
          AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE
            ? 'creates a draft rule for review'
            : 'click Apply to investigate'}
          )
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-amber-800">{label}</dt>
      <dd className="text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function fmt(value: number | null): string {
  if (value == null) return '—';
  return `$${value.toFixed(2)}`;
}

function humanizeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface DeltaResult {
  current_value: number;
  delta_pct: number | null;
}

async function computeActivationDelta(
  builderId: string,
  anomaly: AnomalyEvent,
): Promise<DeltaResult> {
  const windowMs = anomaly.period_end.getTime() - anomaly.period_start.getTime();
  const now = new Date();
  const currentStart = new Date(now.getTime() - windowMs);

  const agg = await fetchPeriodAggregates(builderId, chTimestamp(currentStart), chTimestamp(now));
  const currentValue = costForExternalCustomer(agg, builderId, anomaly.customer_id);

  const baseline = anomaly.actual_value;
  const deltaPct =
    baseline != null && baseline !== 0
      ? Math.round(((currentValue - baseline) / baseline) * 10_000) / 100
      : null;

  return { current_value: currentValue, delta_pct: deltaPct };
}
