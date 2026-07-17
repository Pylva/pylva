// B2a T1 — dashboard overview. 30-day KPIs + top-5 end-users.
// Reads builder_id from middleware headers (I-T1-3 — never from URL).
// B4-4d-2 mounts AnomalyContextPanel when `?anomaly={id}` is present
// (alert deep-link / Recommendations row "Investigate" target).

import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getOverview, getTopEndUsers, hasAnyRealEvents } from '@/lib/clickhouse/dashboard-queries';
import { OnboardingChecklist } from '@/components/dashboard/OnboardingChecklist';
import { UsageDataUnavailable } from '@/components/dashboard/UsageDataUnavailable';
import { Role } from '@pylva/shared';
import { Kpi } from '@/components/dashboard/Kpi';
import { LiveCostFeed } from '@/components/dashboard/LiveCostFeed';
import { AnomalyContextPanel } from '@/components/anomalies/AnomalyContextPanel';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { COPY } from '@/lib/copy';
import { env } from '@/lib/config';
import { formatTelemetryUsd, formatInt } from '@/lib/formatting';
import { logger } from '@/lib/logger';

export const metadata: Metadata = { title: 'Overview' };

const log = logger.child({ module: 'dashboard.overview' });

type OverviewData =
  | { state: 'empty' }
  | {
      state: 'ready';
      kpis: Awaited<ReturnType<typeof getOverview>>;
      topUsers: Awaited<ReturnType<typeof getTopEndUsers>>;
    };

async function loadOverviewData(
  builderId: string,
  range: { from: Date; to: Date },
): Promise<OverviewData> {
  const hasReal = await hasAnyRealEvents(builderId);
  if (!hasReal) return { state: 'empty' };

  const [kpis, topUsers] = await Promise.all([
    getOverview(builderId, range, { includeDemo: false, hasRealEvents: hasReal }),
    getTopEndUsers(builderId, range, 5),
  ]);

  return { state: 'ready', kpis, topUsers };
}

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ anomaly?: string }>;
}) {
  const { builderId, role } = await readDashboardHeaders();
  const { slug } = await params;
  const { anomaly: anomalyId } = await searchParams;

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const range = { from: thirtyDaysAgo, to: now };

  let data: OverviewData;
  try {
    data = await loadOverviewData(builderId, range);
  } catch (err) {
    log.warn(
      {
        builder_id: builderId,
        error: err instanceof Error ? err.message : String(err),
      },
      'dashboard overview data unavailable',
    );
    return <UsageDataUnavailable title="Overview" />;
  }

  if (data.state === 'empty') {
    return (
      <>
        <PageHeader title="Overview" description={COPY.empty_dashboard_body} />
        <div className="mt-6">
          <OnboardingChecklist slug={slug} isOwner={role === Role.OWNER} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description={`Last 30 days of cost across ${COPY.end_user_lower_plural}.`}
      />

      {anomalyId ? (
        <AnomalyContextPanel builderId={builderId} slug={slug} anomalyId={anomalyId} />
      ) : null}

      {env.ENABLE_SSE_FEED ? (
        <LiveCostFeed
          initialTotalUsd={data.kpis.total_spend_usd}
          initialEventCount={data.kpis.event_count}
          initialCustomerCount={data.kpis.customer_count}
          endUserLabel={COPY.end_user_lower}
          customerLabelPlural={COPY.end_user_plural}
        />
      ) : (
        <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Kpi label="Total spend" value={formatTelemetryUsd(data.kpis.total_spend_usd)} />
          <Kpi label="Events" value={formatInt(data.kpis.event_count)} />
          <Kpi label={COPY.end_user_plural} value={formatInt(data.kpis.customer_count)} />
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">Top {COPY.end_user_lower_plural}</h2>
        {data.topUsers.length === 0 ? (
          <p className="mt-4 text-sm text-[color:var(--muted-foreground)]">
            {COPY.empty_dashboard_body}
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {data.topUsers.map((row) => (
              <li
                key={row.customer_id}
                className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3"
              >
                <span className="truncate font-medium">{row.customer_id}</span>
                <span className="text-sm tabular-nums text-[color:var(--muted-foreground)]">
                  {formatTelemetryUsd(row.total_spend_usd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
