// B2a T1 — end-users list. D20: vocabulary says "End-users" in UI chrome,
// customer_id in the URL segment + API for back-compat.

import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getCustomerCostSummary } from '@/lib/clickhouse/dashboard-queries';
import { COPY } from '@/lib/copy';
import { formatTelemetryUsd, formatRelative } from '@/lib/formatting';
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

export const metadata: Metadata = { title: 'End-users' };

const log = logger.child({ module: 'dashboard.end_users' });

export default async function EndUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { builderId } = await readDashboardHeaders();
  const { from: fromRaw, to: toRaw } = await searchParams;
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 86_400_000);

  let rows: Awaited<ReturnType<typeof getCustomerCostSummary>>;
  try {
    rows = await getCustomerCostSummary(
      builderId,
      { from, to },
      { includeDemo: false, limit: 100 },
    );
  } catch (err) {
    log.warn(
      {
        builder_id: builderId,
        error: err instanceof Error ? err.message : String(err),
      },
      'dashboard end-users data unavailable',
    );
    return <UsageDataUnavailable title={COPY.end_user_plural} />;
  }

  return (
    <>
      <PageHeader
        title={COPY.end_user_plural}
        description={`Cost per ${COPY.end_user_lower} over the selected range.`}
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
                <TableHead>{COPY.end_user}</TableHead>
                <TableHead className="text-end">Spend</TableHead>
                <TableHead className="text-end">Events</TableHead>
                <TableHead className="text-end">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.customer_id}>
                  <TableCell>
                    <a
                      href={`./end-users/${encodeURIComponent(row.customer_id)}`}
                      className="font-medium hover:underline"
                    >
                      {row.customer_id}
                    </a>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatTelemetryUsd(row.total_spend_usd)}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {row.event_count.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-end tabular-nums text-[color:var(--muted-foreground)]">
                    {row.last_seen_at ? formatRelative(row.last_seen_at) : '—'}
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
