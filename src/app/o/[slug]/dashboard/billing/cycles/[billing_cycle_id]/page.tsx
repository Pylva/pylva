// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — /o/{slug}/dashboard/billing/cycles/[billing_cycle_id] —
// auto-split view.
//
// Two (or more) drafts emitted from a single billing-period that spanned
// a mid-period pricing change. Groups them under one header, shows the
// boundary date explanation.

import type { Metadata } from 'next';
import { and, eq } from 'drizzle-orm';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { invoices } from '@/lib/db/schema';
import { notFound } from 'next/navigation';
import { formatUsd } from '@/lib/formatting';
import { isUuid } from '@/lib/validation/uuid';

export const metadata: Metadata = { title: 'Billing cycle' };

export default async function CycleViewPage({
  params,
}: {
  params: Promise<{ slug: string; billing_cycle_id: string }>;
}) {
  const { slug, billing_cycle_id } = await params;
  if (!isUuid(billing_cycle_id)) notFound();

  const { builderId } = await readDashboardHeaders();

  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select()
      .from(invoices)
      .where(
        and(eq(invoices.builder_id, builderId), eq(invoices.billing_cycle_id, billing_cycle_id)),
      )
      .orderBy(invoices.period_start),
  );

  if (rows.length === 0) notFound();

  const first = rows[0]!;
  const boundary = rows.length > 1 ? rows[1]!.period_start : first.period_end;

  return (
    <>
      <a
        href={`/o/${slug}/dashboard/billing`}
        className="text-xs text-[color:var(--muted-foreground)] hover:underline"
      >
        ← All invoices
      </a>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Billing cycle</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        Pricing changed on{' '}
        <strong>{new Date(boundary as unknown as string).toLocaleDateString()}</strong> — this cycle
        was split into {rows.length} drafts so each pricing version gets its own invoice.
      </p>

      <div className="mt-6 space-y-3">
        {rows.map((r) => (
          <a
            key={r.id}
            href={`/o/${slug}/dashboard/billing/invoices/${r.id}`}
            className="block rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4 hover:border-[color:var(--primary)]"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-[color:var(--muted-foreground)]">
                  v{r.pricing_version ?? '—'}
                </p>
                <p className="mt-1 text-sm">
                  {new Date(r.period_start as unknown as string).toLocaleDateString()} —{' '}
                  {new Date(r.period_end as unknown as string).toLocaleDateString()}
                </p>
              </div>
              <div className="text-right">
                <p className="text-base font-semibold tabular-nums">{formatUsd(r.amount_usd)}</p>
                <p className="mt-1 text-xs">
                  <code className="rounded bg-[color:var(--muted)] px-1.5 py-0.5">{r.status}</code>
                </p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
