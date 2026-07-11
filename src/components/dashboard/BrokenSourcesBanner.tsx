// Track 2 PR 2.5 (per O39) — persistent banner shown at the top of the
// dashboard whenever any cost_source has status='broken'. Builder alert
// channel delivery is handled by the health-check cron + builder-alert
// helper; this banner is the in-dashboard surface.

import { and, eq } from 'drizzle-orm';
import { CostSourceStatus } from '@pylva/shared';
import { withRLS } from '@/lib/db/rls';
import { costSources } from '@/lib/db/schema';
import { COPY } from '@/lib/copy';

interface Props {
  builderId: string;
  slug: string;
}

export async function BrokenSourcesBanner({ builderId, slug }: Props) {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({
        id: costSources.id,
        display_name: costSources.display_name,
        slug: costSources.slug,
      })
      .from(costSources)
      .where(
        and(eq(costSources.builder_id, builderId), eq(costSources.status, CostSourceStatus.BROKEN)),
      )
      .limit(5),
  );

  if (rows.length === 0) return null;

  return (
    <div
      className="mb-6 flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-50 p-4 dark:bg-red-950/30"
      role="alert"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-red-900 dark:text-red-100">
          {COPY.broken_sources_title}
        </div>
        <div className="mt-1 text-xs text-red-900/80 dark:text-red-100/80">
          {rows.map((r) => r.display_name).join(', ')}
          {rows.length === 5 ? ' …' : ''}
        </div>
      </div>
      <a
        href={`/o/${slug}/dashboard/cost-sources`}
        className="shrink-0 rounded-md border border-red-500/40 px-3 py-1 text-xs font-medium text-red-900 hover:bg-red-100 dark:text-red-100 dark:hover:bg-red-950/50"
      >
        Investigate →
      </a>
    </div>
  );
}
