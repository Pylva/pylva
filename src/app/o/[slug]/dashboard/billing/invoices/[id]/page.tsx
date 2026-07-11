// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — /o/{slug}/dashboard/billing/invoices/[id] — invoice detail.
//
// Shows amount, line items (with pricing_version badge), period, Stripe
// hosted URL (if we have it), timestamps. Renders action buttons (Finalize /
// Void) when status allows. Uses server-action forms POSTing to the API
// routes.

import type { Metadata } from 'next';
import { and, eq } from 'drizzle-orm';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { invoices } from '@/lib/db/schema';
import type { InvoiceLineItem } from '@pylva/shared';
import { notFound } from 'next/navigation';
import { formatUsd } from '@/lib/formatting';
import { UnpricedBanner } from '@/components/billing/UnpricedBanner';
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
import { DashboardActionButton } from '@/components/dashboard/DashboardActionButton';

export const metadata: Metadata = { title: 'Invoice' };

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  if (!isUuid(id)) notFound();

  const { builderId, role } = await readDashboardHeaders();
  const isOwner = role === 'owner';

  const row = await withRLS(builderId, async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.builder_id, builderId), eq(invoices.id, id)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!row) notFound();

  const lineItems = (row.line_items ?? []) as InvoiceLineItem[];

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <a
            href={`/o/${slug}/dashboard/billing`}
            className="text-xs text-[color:var(--muted-foreground)] hover:underline"
          >
            ← All invoices
          </a>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Invoice</h1>
          <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
            <code className="text-xs">{row.id}</code>
          </p>
        </div>
        <div className="flex gap-2">
          {row.status === 'draft' && isOwner ? (
            <DashboardActionButton
              endpoint={`/api/v1/billing/invoices/${row.id}/finalize`}
              label="Finalize"
              className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm text-[color:var(--primary-foreground)]"
            />
          ) : null}
          {['draft', 'pending'].includes(row.status) && isOwner ? (
            <DashboardActionButton
              endpoint={`/api/v1/billing/invoices/${row.id}/void`}
              label="Void"
              className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm"
            />
          ) : null}
        </div>
      </div>

      {row.has_unpriced_events ? (
        <div className="mt-6">
          <UnpricedBanner href={`/o/${slug}/dashboard/cost-sources/pricing`}>
            This invoice <strong>excludes unpriced usage</strong> — those events aren’t billed, so
            this customer may be under-charged. Price the metric and it’ll be included on the next
            invoice.
          </UnpricedBanner>
        </div>
      ) : null}

      <div className="mt-6 grid grid-cols-2 gap-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6 text-sm">
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">Amount</span>
          <p className="mt-1 text-xl font-semibold tabular-nums">{formatUsd(row.amount_usd)}</p>
        </div>
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">Status</span>
          <p className="mt-1">
            <code className="rounded bg-[color:var(--muted)] px-1.5 py-0.5 text-xs">
              {row.status}
            </code>
          </p>
        </div>
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">Period</span>
          <p className="mt-1 text-xs">
            {new Date(row.period_start as unknown as string).toLocaleDateString()} —{' '}
            {new Date(row.period_end as unknown as string).toLocaleDateString()}
          </p>
        </div>
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">
            Pricing version
          </span>
          <p className="mt-1 text-xs">v{row.pricing_version ?? '—'}</p>
        </div>
        {row.billing_cycle_id ? (
          <div className="col-span-2 text-xs">
            This invoice is part of a split cycle —{' '}
            <a
              href={`/o/${slug}/dashboard/billing/cycles/${row.billing_cycle_id}`}
              className="underline"
            >
              view the other drafts
            </a>
            .
          </div>
        ) : null}
      </div>

      <section className="mt-6">
        <h2 className="text-base font-semibold">Line items</h2>
        {lineItems.length === 0 ? (
          <p className="mt-2 text-sm text-[color:var(--muted-foreground)]">No line items.</p>
        ) : (
          <TableContainer className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-end">Qty</TableHead>
                  <TableHead className="text-end">Unit</TableHead>
                  <TableHead className="text-end">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineItems.map((li, i) => (
                  <TableRow key={i}>
                    <TableCell>{li.description}</TableCell>
                    <TableCell className="text-end tabular-nums">{li.quantity}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatUsd(li.unit_price_usd)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatUsd(li.total_usd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </section>

      {row.stripe_invoice_id ? (
        <p className="mt-6 text-xs text-[color:var(--muted-foreground)]">
          Stripe invoice id: <code>{row.stripe_invoice_id}</code>
        </p>
      ) : null}
    </>
  );
}
