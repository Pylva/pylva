// Per-source pricing config page. Loads the cost_sources row by slug and
// hands it to the client form. Returns 404 when the source doesn't exist
// for this builder (RLS-scoped via withRLS).

import type { Metadata } from 'next';
import { and, eq } from 'drizzle-orm';
import {
  CostSourceTrackingStatus,
  Role,
  type CostSourceTrackingStatus as TrackingStatus,
  type CostSourceType as SourceType,
  type PricingTier,
} from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { costSources } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';
import { COPY } from '@/lib/copy';
import { PricingConfigForm } from '@/components/cost-sources/PricingConfigForm';
import { EmptyStateCard } from '@/components/dashboard/EmptyStateCard';

export const metadata: Metadata = { title: 'Cost source pricing' };

export default async function CostSourcePricingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const [{ slug }, { source }, { builderId, role }] = await Promise.all([
    params,
    searchParams,
    readDashboardHeaders(),
  ]);
  const canMutate = role === Role.OWNER;

  if (!source) {
    return <MissingSlugMessage slug={slug} />;
  }

  const row = await withRLS(builderId, async (tx) => {
    const rows = await tx
      .select({
        display_name: costSources.display_name,
        slug: costSources.slug,
        unit: costSources.unit,
        metric: costSources.metric,
        price_per_unit: costSources.price_per_unit,
        pricing_tiers: costSources.pricing_tiers,
        source_type: costSources.source_type,
        tracking_status: costSources.tracking_status,
        matchers: costSources.matchers,
        default_metric_value: costSources.default_metric_value,
      })
      .from(costSources)
      .where(and(eq(costSources.builder_id, builderId), eq(costSources.slug, source)))
      .limit(1);
    return rows[0] ?? null;
  });

  if (!row) {
    return <NotFoundMessage slug={slug} />;
  }

  return (
    <>
      <div className="mb-6">
        <a
          href={`/o/${slug}/dashboard/cost-sources`}
          className="text-sm text-[color:var(--muted-foreground)] hover:underline"
        >
          ← Back to cost sources
        </a>
      </div>

      <h1 className="text-2xl font-semibold tracking-tight">Pricing — {row.display_name}</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        Configure how Pylva calculates cost for events tagged with this source.
      </p>
      <p className="mt-2 rounded-md border border-[color:var(--border)] bg-[color:var(--muted)] px-3 py-2 text-xs text-[color:var(--muted-foreground)]">
        {COPY.cost_source_future_events_only}
      </p>
      {!canMutate ? (
        <p className="mt-2 text-xs text-[color:var(--muted-foreground)]">
          {COPY.cost_source_member_view_only}
        </p>
      ) : null}

      <div className="mt-8 max-w-2xl">
        <PricingConfigForm
          slug={row.slug}
          sourceType={row.source_type as SourceType}
          displayName={row.display_name}
          metric={row.metric}
          unit={row.unit}
          trackingStatus={
            (row.tracking_status ?? CostSourceTrackingStatus.TRACKED) as TrackingStatus
          }
          matchers={row.matchers ?? []}
          defaultMetricValue={
            row.default_metric_value === null ? null : Number(row.default_metric_value)
          }
          initialPricePerUnit={row.price_per_unit !== null ? Number(row.price_per_unit) : null}
          initialTiers={(row.pricing_tiers as PricingTier[] | null) ?? null}
          readOnly={!canMutate}
        />
      </div>
    </>
  );
}

function MissingSlugMessage({ slug }: { slug: string }) {
  return (
    <EmptyStateCard
      title="Choose a cost source first."
      action={
        <a
          href={`/o/${slug}/dashboard/cost-sources`}
          className="text-sm text-[color:var(--primary)] hover:underline"
        >
          Back to cost sources →
        </a>
      }
    />
  );
}

function NotFoundMessage({ slug }: { slug: string }) {
  return (
    <EmptyStateCard
      title="Cost source not found."
      action={
        <a
          href={`/o/${slug}/dashboard/cost-sources`}
          className="text-sm text-[color:var(--primary)] hover:underline"
        >
          Back to cost sources →
        </a>
      }
    />
  );
}
