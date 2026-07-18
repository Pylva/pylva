// B2a T1 — per end-user detail. Totals + breakdowns.
// customer_id URL segment carries the external_id; we try both composite +
// raw forms against ClickHouse to match demo seed vs live data.

import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getCustomerDetail } from '@/lib/clickhouse/dashboard-queries';
import { notFound } from 'next/navigation.js';
import { COPY } from '@/lib/copy';
import { formatTelemetryUsd } from '@/lib/formatting';
import { BudgetActivityPanel } from '@/components/budget-activity/BudgetActivityPanel';
import { parseBudgetActivityQuery } from '@/lib/budget-activity/query';
import { getBudgetAccountState, listBudgetActivity } from '@/lib/budget-activity/read-model';

export const metadata: Metadata = { title: 'End user' };

export default async function EndUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { builderId } = await readDashboardHeaders();
  const { slug, id } = await params;
  const { from: fromRaw, to: toRaw } = await searchParams;
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 86_400_000);

  const externalId = decodeURIComponent(id);

  // Production reads only real events; legacy/dev composite form (demo seed)
  // is kept available via the includeDemo flag in dashboard-queries but is
  // not auto-enabled here. Both ID forms fire in one wave (launch perf) —
  // composite (live data) wins whenever it has events.
  const authoritativeCustomer = /^[A-Za-z0-9_-]{1,255}$/.test(externalId);
  const activityQuery = authoritativeCustomer
    ? parseBudgetActivityQuery(new URLSearchParams({ customer: externalId, page_size: '10' }))
    : null;
  const [composite, raw, activityPage, accounts] = await Promise.all([
    getCustomerDetail(
      builderId,
      `${builderId}:${externalId}`,
      { from, to },
      { includeDemo: false },
    ),
    getCustomerDetail(builderId, externalId, { from, to }, { includeDemo: false }),
    activityQuery
      ? listBudgetActivity(builderId, activityQuery)
      : Promise.resolve({ activities: [] }),
    authoritativeCustomer
      ? getBudgetAccountState(builderId, { customer_id: externalId, limit: 8 })
      : Promise.resolve([]),
  ]);
  const detail = composite.event_count > 0 ? composite : raw;
  if (detail.event_count === 0 && activityPage.activities.length === 0 && accounts.length === 0) {
    notFound();
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">{externalId}</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        {COPY.end_user} · last 30 days
      </p>

      <section className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card label="Total spend" value={formatTelemetryUsd(detail.total_spend_usd)} />
        <Card label="Events" value={detail.event_count.toLocaleString()} />
      </section>

      <section className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">By model</h2>
          {detail.by_model.length === 0 ? (
            <NoSpendBreakdown />
          ) : (
            <ul className="mt-4 space-y-2 text-sm">
              {detail.by_model.slice(0, 10).map((r) => (
                <li
                  key={`${r.provider}/${r.model ?? '-'}`}
                  className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-3 py-2"
                >
                  <span className="truncate">
                    {r.provider}/{r.model ?? '—'}
                  </span>
                  <span className="text-[color:var(--muted-foreground)] tabular-nums">
                    {formatTelemetryUsd(r.spend_usd)} · {r.call_count}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">By step</h2>
          {detail.by_step.length === 0 ? (
            <NoSpendBreakdown />
          ) : (
            <ul className="mt-4 space-y-2 text-sm">
              {detail.by_step.slice(0, 10).map((r) => (
                <li
                  key={r.step_name ?? '-'}
                  className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-3 py-2"
                >
                  <span className="truncate">{r.step_name ?? '(unnamed)'}</span>
                  <span className="text-[color:var(--muted-foreground)] tabular-nums">
                    {formatTelemetryUsd(r.spend_usd)} · {r.call_count}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">Daily spend</h2>
        {detail.daily.length === 0 ? (
          <NoSpendBreakdown />
        ) : (
          <ul className="mt-4 space-y-1 font-mono text-xs">
            {detail.daily.map((d) => (
              <li key={d.day} className="flex items-center gap-3">
                <span className="text-[color:var(--muted-foreground)] w-24">{d.day}</span>
                <div className="h-2 flex-1 rounded-sm bg-[color:var(--muted)]">
                  <div
                    className="h-2 rounded-sm bg-[color:var(--primary)]"
                    style={{ width: `${relWidth(d.spend_usd, detail.daily)}%` }}
                  />
                </div>
                <span className="w-24 text-right tabular-nums">
                  {formatTelemetryUsd(d.spend_usd)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <BudgetActivityPanel
        activities={activityPage.activities}
        accounts={accounts}
        slug={slug}
        title="End-user budget control"
      />
    </>
  );
}

function NoSpendBreakdown() {
  return (
    <p className="mt-4 rounded-md border border-dashed border-[color:var(--border)] p-3 text-sm text-[color:var(--muted-foreground)]">
      No charged usage. Control-only actions stay out of spend and event totals.
    </p>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6">
      <div className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
        {label}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function relWidth(value: number, rows: { spend_usd: number }[]): number {
  const max = Math.max(...rows.map((r) => r.spend_usd));
  if (max === 0) return 0;
  return Math.round((value / max) * 100);
}
