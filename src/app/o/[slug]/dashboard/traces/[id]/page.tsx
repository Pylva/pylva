// B2a T1 — trace tree view. Flat-indented layout (D23): one row per span,
// collapsible subtrees client-side. Cap display 10K spans + CSV export CTA.

import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getTraceTree } from '@/lib/clickhouse/dashboard-queries';
import { TraceTree } from '@/components/dashboard/TraceTree';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation.js';
import { DashboardDownloadLink } from '@/components/dashboard/DashboardDownloadLink';
import { BudgetActivityPanel } from '@/components/budget-activity/BudgetActivityPanel';
import { parseBudgetActivityQuery } from '@/lib/budget-activity/query';
import { getBudgetAccountState, listBudgetActivity } from '@/lib/budget-activity/read-model';

export const metadata: Metadata = { title: 'Trace' };

export default async function TracePage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { builderId } = await readDashboardHeaders();
  const { slug, id: traceId } = await params;
  const activityQuery = parseBudgetActivityQuery(
    new URLSearchParams({ trace_id: traceId, page_size: '50' }),
  );
  const [result, activityPage, accounts] = await Promise.all([
    getTraceTree(builderId, traceId),
    listBudgetActivity(builderId, activityQuery),
    getBudgetAccountState(builderId, { trace_id: traceId, limit: 8 }),
  ]);
  if (result.spans.length === 0 && activityPage.activities.length === 0) notFound();
  const spanIds = new Set(result.spans.map((span) => span.span_id));
  const unmatchedActions = activityPage.activities.filter(
    (activity) => activity.status !== 'charged' || !spanIds.has(activity.span_id),
  );

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Trace</h1>
      <p className="mt-1 font-mono text-xs text-[color:var(--muted-foreground)]">{traceId}</p>

      {result.spans.length === 0 ? (
        <div className="mt-5 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <div className="font-medium">⊘ No cost span was created.</div>
          <div className="mt-1">
            This blocked-only trace exists because PostgreSQL recorded the control decision before
            provider dispatch.
          </div>
        </div>
      ) : null}

      {result.truncated && result.spans[0] ? (
        <div className="mt-4 rounded-md border border-[color:var(--border)] bg-[color:var(--muted)] p-3 text-sm">
          Displaying {result.spans.length.toLocaleString()} of{' '}
          {result.totalSpanCount.toLocaleString()} spans.{' '}
          <DashboardDownloadLink
            href={`/api/v1/export/csv?from=${encodeURIComponent(new Date(result.spans[0]!.timestamp).toISOString())}`}
          >
            Export the full trace as CSV
          </DashboardDownloadLink>
          .
        </div>
      ) : null}

      <section className="mt-6">
        <TraceTree spans={result.spans} controlActions={activityPage.activities} />
      </section>

      <BudgetActivityPanel
        activities={unmatchedActions}
        accounts={accounts}
        slug={slug}
        title="Trace budget control"
      />
    </>
  );
}
