// B2b T2-E — /o/{slug}/dashboard/end-users/[id]/pricing — the pricing
// editor page. Shows current + version history at the bottom.

import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getActiveVersion, getAllVersions } from '@/lib/billing/pricing-versioning';
import { PricingEditor } from '@/components/billing/PricingEditor';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { notFound } from 'next/navigation';
import { withRLS } from '@/lib/db/rls';
import { customers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

export const metadata: Metadata = { title: 'End-user pricing' };

export default async function CustomerPricingPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { id: externalId } = await params;
  const { builderId } = await readDashboardHeaders();

  // `id` in the URL is the external id (e.g. "acme-corp"); resolve to the
  // customers.id UUID for the API routes + versioning reads.
  const customerRow = await withRLS(builderId, async (tx) => {
    const rows = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.builder_id, builderId), eq(customers.external_id, externalId)))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!customerRow) notFound();

  const [current, history] = await Promise.all([
    getActiveVersion({ builderId, customerId: customerRow.id }),
    getAllVersions({ builderId, customerId: customerRow.id }),
  ]);

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Pricing — {externalId}</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        Change pricing here. Mid-period changes auto-split the next invoice.
      </p>

      <div className="mt-6">
        <PricingEditor
          customerId={customerRow.id}
          initial={current as unknown as Record<string, unknown> | null}
        />
      </div>

      {history.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-base font-semibold">Version history</h2>
          <TableContainer className="mt-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead>Effective to</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-xs">v{row.version}</TableCell>
                    <TableCell className="text-xs">{row.pricing_model}</TableCell>
                    <TableCell className="text-xs">
                      {new Date(row.effective_from).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.effective_to ? new Date(row.effective_to).toLocaleString() : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </section>
      ) : null}
    </>
  );
}
