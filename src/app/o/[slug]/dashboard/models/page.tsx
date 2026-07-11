// B2a T1 — model breakdown across all end-users.

import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getModelBreakdown } from '@/lib/clickhouse/dashboard-queries';
import { COPY } from '@/lib/copy';
import { PageHeader } from '@/components/dashboard/PageHeader';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { UsageDataUnavailable } from '@/components/dashboard/UsageDataUnavailable';
import { logger } from '@/lib/logger';

export const metadata: Metadata = { title: 'Models' };

const log = logger.child({ module: 'dashboard.models' });

function parseDateParam(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export default async function ModelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { builderId } = await readDashboardHeaders();
  const { slug } = await params;
  const { from: fromRaw, to: toRaw } = await searchParams;
  const to = parseDateParam(toRaw) ?? new Date();
  const from = parseDateParam(fromRaw) ?? new Date(to.getTime() - 30 * 86_400_000);

  let rows: Awaited<ReturnType<typeof getModelBreakdown>>;
  try {
    rows = await getModelBreakdown(builderId, { from, to }, { includeDemo: false });
  } catch (err) {
    log.warn(
      {
        builder_id: builderId,
        error: err instanceof Error ? err.message : String(err),
      },
      'dashboard models data unavailable',
    );
    return <UsageDataUnavailable title="Models" />;
  }

  return (
    <>
      <PageHeader
        title="Models"
        description={`Per-model spend across all ${COPY.end_user_lower_plural}.`}
      />

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-[color:var(--muted-foreground)]">
          {COPY.empty_dashboard_body}
        </p>
      ) : (
        <TableContainer className="mt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / model</TableHead>
                <TableHead className="text-end">Spend</TableHead>
                <TableHead className="text-end">Tokens in</TableHead>
                <TableHead className="text-end">Tokens out</TableHead>
                <TableHead className="text-end">Calls</TableHead>
                <TableHead className="text-end">Avg $/call</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Simulate</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.provider}/${r.model ?? '-'}`}>
                  <TableCell className="font-medium">
                    {r.provider} / {r.model ?? '—'}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">{fmt$(r.total_spend_usd)}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {r.tokens_in.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {r.tokens_out.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {r.call_count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {fmt$(r.avg_usd_per_call)}
                  </TableCell>
                  <TableCell className="text-end">
                    {r.model && (
                      <a
                        href={`/o/${slug}/dashboard/simulator?model=${encodeURIComponent(r.model)}&provider=${encodeURIComponent(r.provider)}`}
                        className="whitespace-nowrap text-xs text-[color:var(--primary)] hover:underline"
                      >
                        What if?
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
}

function fmt$(v: number): string {
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}
