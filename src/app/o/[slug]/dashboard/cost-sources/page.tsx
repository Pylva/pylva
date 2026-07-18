// Cost Sources list page. Reads the cost_sources rows for the authenticated
// builder and renders a card per source with a health badge, last-seen
// timestamp, source-type chip, and a link to the pricing config page.

import type { Metadata } from 'next';
import { eq, sql } from 'drizzle-orm';
import {
  CostSourceStatus,
  CostSourceTrackingStatus,
  CostSourceType,
  type CostSourceStatus as Status,
  type CostSourceTrackingStatus as TrackingStatus,
  type CostSourceType as SourceType,
  Role,
} from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { COPY } from '@/lib/copy';
import { costSources } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';
import { withBudgetControlReadTransaction } from '@/lib/budget-control/read-transaction';
import { unwrapRows } from '@/lib/db/query-utils';
import { EmptyStateCard } from '@/components/dashboard/EmptyStateCard';
import { PageHeader } from '@/components/dashboard/PageHeader';
import {
  CostSourcesControlTable,
  type CostSourceControlRow,
} from '@/components/cost-sources/CostSourcesControlTable';
import { deriveCostSourceProtectionState } from '@/lib/cost-sources/protection';
import { env } from '@/lib/config';
import { getBudgetControlProductionPosture } from '@/lib/budget-control/runtime-posture';

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

interface CostSourceAuthorityRow {
  control_ready: boolean;
  has_active_hard_stop_budget: boolean;
}

async function readCostSourceAuthority(builderId: string): Promise<{
  controlReady: boolean;
  hasActiveHardStopBudget: boolean;
}> {
  return withBudgetControlReadTransaction(builderId, async (transaction) => {
    const result = await transaction.execute(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM public.budget_control_cutovers cutover
          WHERE cutover.builder_id = ${builderId}::UUID
            AND cutover.status = 'ready'
        ) AS control_ready,
        EXISTS (
          SELECT 1
          FROM public.budget_rule_revisions revision
          WHERE revision.builder_id = ${builderId}::UUID
            AND revision.enforcement = 'hard_stop'
            AND revision.retired_at IS NULL
        ) AS has_active_hard_stop_budget
    `);
    const row = unwrapRows<CostSourceAuthorityRow>(result)[0];
    return {
      controlReady: row?.control_ready === true,
      hasActiveHardStopBudget: row?.has_active_hard_stop_budget === true,
    };
  });
}

export default async function CostSourcesPage({ params }: { params: Promise<{ slug: string }> }) {
  const [{ slug }, { builderId, role }] = await Promise.all([params, readDashboardHeaders()]);

  const authoritativeRequested = env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL;
  const runtimePosturePromise = authoritativeRequested
    ? getBudgetControlProductionPosture()
        .then((posture) => posture.ready)
        .catch(() => false)
    : Promise.resolve(false);

  const [rows, postureReady] = await Promise.all([
    withRLS(builderId, async (tx) =>
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
    ),
    runtimePosturePromise,
  ]);

  const authoritativeEnabled = authoritativeRequested && postureReady;
  const { controlReady: workspaceControlReady, hasActiveHardStopBudget } = authoritativeEnabled
    ? await readCostSourceAuthority(builderId)
    : { controlReady: false, hasActiveHardStopBudget: false };
  const controlReady = authoritativeEnabled && workspaceControlReady;

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
      r.source_type === CostSourceType.LLM_PROVIDER ||
      r.price_per_unit !== null ||
      (Array.isArray(r.pricing_tiers) && r.pricing_tiers.length > 0),
  }));
  const clientRows: CostSourceControlRow[] = sources.map((source) => ({
    ...source,
    protection_state: deriveCostSourceProtectionState({
      trackingStatus: source.tracking_status,
      healthStatus: source.status,
      hasPricing: source.has_pricing,
      authoritativeEnabled,
      controlReady,
      hasActiveHardStopBudget,
    }),
    last_seen_at: source.last_seen_at ? source.last_seen_at.toISOString() : null,
    last_discovered_at: source.last_discovered_at ? source.last_discovered_at.toISOString() : null,
  }));

  return (
    <>
      <PageHeader
        title={COPY.cost_sources_page_title}
        description={COPY.cost_sources_page_subtitle}
      />
      <p
        role="status"
        aria-label="Budget control status"
        className="mt-3 max-w-3xl rounded-md border border-[color:var(--border)] px-3 py-2 text-xs text-[color:var(--muted-foreground)]"
      >
        <span className="font-medium text-[color:var(--foreground)]">Budget control:</span>{' '}
        {!authoritativeRequested
          ? 'Tracking only. Authoritative enforcement is not enabled.'
          : !postureReady
            ? 'Tracking only. The enforcement runtime has not passed readiness checks, so no source is marked Protected.'
            : !workspaceControlReady
              ? 'Tracking only. This workspace has not completed its enforcement cutover.'
              : "Control path ready. Protected means at least one active hard-stop budget can gate this priced source. Exact coverage still follows each rule's scope."}
      </p>

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
