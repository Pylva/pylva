// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — /o/{slug}/dashboard/billing — invoice list.
//
// Table + filters (customer, status, period, billing_cycle_id). Draft
// banner on top. Deep-links to invoice detail + cycles view when the row
// is part of a split.

import type { Metadata } from 'next';
import { and, count, desc, eq } from 'drizzle-orm';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { invoices } from '@/lib/db/schema';
import { DraftBanner } from '@/components/dashboard/DraftBanner';
import { UnpricedBanner } from '@/components/billing/UnpricedBanner';
import { formatUsd } from '@/lib/formatting';
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
import { isUuid } from '@/lib/validation/uuid';

export const metadata: Metadata = { title: 'Invoices' };

const PAGE_SIZE = 50;
const INVOICE_STATUSES = ['draft', 'pending', 'paid', 'failed', 'void'] as const;
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === 'string' && (INVOICE_STATUSES as readonly string[]).includes(value);
}

function parseOffset(value: string | undefined): number {
  const parsed = Number(value ?? '0');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export default async function BillingListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string; customer_id?: string; cycle?: string; offset?: string }>;
}) {
  const { slug } = await params;
  const { status, customer_id, cycle, offset: offsetRaw } = await searchParams;
  const { builderId } = await readDashboardHeaders();
  const offset = parseOffset(offsetRaw);
  const statusFilter = status && isInvoiceStatus(status) ? status : undefined;
  const customerIdFilter = customer_id && isUuid(customer_id) ? customer_id : undefined;
  const cycleFilter = cycle && isUuid(cycle) ? cycle : undefined;
  const hasMalformedFilter = Boolean(
    (status && !statusFilter) || (customer_id && !customerIdFilter) || (cycle && !cycleFilter),
  );

  const conditions = [eq(invoices.builder_id, builderId)];
  if (statusFilter) conditions.push(eq(invoices.status, statusFilter));
  if (customerIdFilter) conditions.push(eq(invoices.customer_id, customerIdFilter));
  if (cycleFilter) conditions.push(eq(invoices.billing_cycle_id, cycleFilter));

  const [rows, draftCountRow, unpricedCountRow] = await Promise.all([
    hasMalformedFilter
      ? Promise.resolve([])
      : withRLS(builderId, async (tx) =>
          tx
            .select()
            .from(invoices)
            .where(and(...conditions))
            .orderBy(desc(invoices.created_at))
            .limit(PAGE_SIZE)
            .offset(offset),
        ),
    withRLS(builderId, async (tx) =>
      tx
        .select({ c: count() })
        .from(invoices)
        .where(and(eq(invoices.builder_id, builderId), eq(invoices.status, 'draft')))
        .then((r) => r[0]),
    ),
    withRLS(builderId, async (tx) =>
      tx
        .select({ c: count() })
        .from(invoices)
        .where(and(eq(invoices.builder_id, builderId), eq(invoices.has_unpriced_events, true)))
        .then((r) => r[0]),
    ),
  ]);

  const draftCount = Number(draftCountRow?.c ?? 0);
  const unpricedCount = Number(unpricedCountRow?.c ?? 0);

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Generated drafts and past invoices for your end-users."
      />

      <DraftBanner count={draftCount} href={`/o/${slug}/dashboard/billing?status=draft`} />

      {unpricedCount > 0 ? (
        <UnpricedBanner href={`/o/${slug}/dashboard/cost-sources/pricing`}>
          <strong>{unpricedCount}</strong>{' '}
          {unpricedCount === 1 ? 'invoice excludes' : 'invoices exclude'} unpriced usage that isn’t
          being billed.
        </UnpricedBanner>
      ) : null}

      <form method="get" className="app-card mt-4 flex flex-wrap gap-2 p-3 text-xs">
        <select
          name="status"
          aria-label="Filter by status"
          defaultValue={statusFilter ?? ''}
          className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1"
        >
          <option value="">All statuses</option>
          {INVOICE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="customer_id"
          aria-label="Filter by customer id"
          defaultValue={customer_id ?? ''}
          placeholder="Filter by customer id…"
          className="w-64 rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1"
        />
        <button
          type="submit"
          className="rounded-md border border-[color:var(--border)] px-3 py-1 hover:bg-[color:var(--accent)]"
        >
          Apply
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-[color:var(--muted-foreground)]">
          No invoices match these filters yet.
        </p>
      ) : (
        <TableContainer className="mt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-end">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cycle</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <a
                      href={`/o/${slug}/dashboard/billing/invoices/${r.id}`}
                      className="hover:underline"
                    >
                      {new Date(r.created_at as unknown as string).toLocaleDateString()}
                    </a>
                  </TableCell>
                  <TableCell className="text-xs">{r.customer_id}</TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatUsd(r.amount_usd)}
                    {r.has_unpriced_events ? (
                      <span
                        title="Excludes unpriced usage — price your metrics to bill it"
                        className="ms-2 rounded bg-amber-500/15 px-1.5 py-0.5 align-middle text-[10px] font-medium text-amber-800"
                      >
                        excl. usage
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-[color:var(--muted)] px-1.5 py-0.5 text-xs">
                      {r.status}
                    </code>
                  </TableCell>
                  <TableCell>
                    {r.billing_cycle_id ? (
                      <a
                        href={`/o/${slug}/dashboard/billing/cycles/${r.billing_cycle_id}`}
                        className="text-xs hover:underline"
                      >
                        split
                      </a>
                    ) : (
                      <span className="text-xs text-[color:var(--muted-foreground)]">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {rows.length === PAGE_SIZE ? (
        <nav className="mt-4 flex justify-end text-xs">
          <a
            href={`?offset=${offset + PAGE_SIZE}${statusFilter ? `&status=${statusFilter}` : ''}${customerIdFilter ? `&customer_id=${customerIdFilter}` : ''}${cycleFilter ? `&cycle=${cycleFilter}` : ''}`}
            className="underline"
          >
            Next page →
          </a>
        </nav>
      ) : null}
    </>
  );
}
