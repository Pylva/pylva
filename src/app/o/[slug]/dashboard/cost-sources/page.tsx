// Cost Sources list page. Reads the cost_sources rows for the authenticated
// builder and renders a card per source with a health badge, last-seen
// timestamp, source-type chip, and a link to the pricing config page.

import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import {
  CostSourceStatus,
  CostSourceTrackingStatus,
  type CostSourceStatus as Status,
  type CostSourceTrackingStatus as TrackingStatus,
  type CostSourceType as SourceType,
  Role,
} from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { COPY } from '@/lib/copy';
import { costSources } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';
import { EmptyStateCard } from '@/components/dashboard/EmptyStateCard';
import { PageHeader } from '@/components/dashboard/PageHeader';
import {
  CostSourcesControlTable,
  type CostSourceControlRow,
} from '@/components/cost-sources/CostSourcesControlTable';

export const metadata: Metadata = { title: 'Cost sources' };

interface CostSourceListRow {
  id: string;
  source_type: SourceType;
  display_name: string;
  slug: string;
  metric: string | null;
  unit: string | null;
  status: Status;
  tracking_status: TrackingStatus;
  matchers: string[];
  last_seen_at: Date | null;
  last_discovered_at: Date | null;
  discovery_count: number;
  has_pricing: boolean;
}

export default async function CostSourcesPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, { builderId, role }] = await Promise.all([params, readDashboardHeaders()]);

  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({
        id: costSources.id,
        source_type: costSources.source_type,
        display_name: costSources.display_name,
        slug: costSources.slug,
        metric: costSources.metric,
        unit: costSources.unit,
        price_per_unit: costSources.price_per_unit,
        pricing_tiers: costSources.pricing_tiers,
        status: costSources.status,
        tracking_status: costSources.tracking_status,
        matchers: costSources.matchers,
        last_seen_at: costSources.last_seen_at,
        last_discovered_at: costSources.last_discovered_at,
        discovery_count: costSources.discovery_count,
      })
      .from(costSources)
      .where(eq(costSources.builder_id, builderId)),
  );

  const sources: CostSourceListRow[] = rows.map((r) => ({
    id: r.id,
    source_type: r.source_type as SourceType,
    display_name: r.display_name,
    slug: r.slug,
    metric: r.metric,
    unit: r.unit,
    status: r.status as Status,
    tracking_status: (r.tracking_status ?? CostSourceTrackingStatus.TRACKED) as TrackingStatus,
    matchers: r.matchers ?? [],
    last_seen_at: r.last_seen_at,
    last_discovered_at: r.last_discovered_at,
    discovery_count: r.discovery_count ?? 0,
    has_pricing:
      r.price_per_unit !== null || (Array.isArray(r.pricing_tiers) && r.pricing_tiers.length > 0),
  }));
  const clientRows: CostSourceControlRow[] = sources.map((source) => ({
    ...source,
    last_seen_at: source.last_seen_at ? source.last_seen_at.toISOString() : null,
    last_discovered_at: source.last_discovered_at ? source.last_discovered_at.toISOString() : null,
  }));

  return (
    <>
      <PageHeader
        title={COPY.cost_sources_page_title}
        description={COPY.cost_sources_page_subtitle}
      />

      {sources.length === 0 ? (
        <EmptyStateCard
          variant="dashed"
          title="No cost sources yet."
          body={
            <>
              <p>
                LLM providers auto-register on first ingest. Discovered non-LLM tools appear here as
                pending approvals.
              </p>
              <p className="mt-3 text-xs">
                Status badges:{' '}
                {[CostSourceStatus.HEALTHY, CostSourceStatus.WARNING, CostSourceStatus.BROKEN].join(
                  ', ',
                )}
                .
              </p>
            </>
          }
        />
      ) : (
        <CostSourcesControlTable slug={slug} sources={clientRows} canMutate={role === Role.OWNER} />
      )}
    </>
  );
}
