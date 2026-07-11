// B2a T1 — trace tree view. Flat-indented layout (D23): one row per span,
// collapsible subtrees client-side. Cap display 10K spans + CSV export CTA.

import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getTraceTree } from '@/lib/clickhouse/dashboard-queries';
import { TraceTree } from '@/components/dashboard/TraceTree';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation.js';
import { DashboardDownloadLink } from '@/components/dashboard/DashboardDownloadLink';

export const metadata: Metadata = { title: 'Trace' };

export default async function TracePage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { builderId } = await readDashboardHeaders();
  const { id: traceId } = await params;
  const result = await getTraceTree(builderId, traceId);
  if (result.spans.length === 0) notFound();

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Trace</h1>
      <p className="mt-1 font-mono text-xs text-[color:var(--muted-foreground)]">{traceId}</p>

      {result.truncated ? (
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
        <TraceTree spans={result.spans} />
      </section>
    </>
  );
}
