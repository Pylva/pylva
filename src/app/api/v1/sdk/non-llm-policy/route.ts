import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq, inArray } from 'drizzle-orm';
import {
  CostSourceTrackingStatus,
  type NonLlmPolicyResponse,
  type NonLlmPolicySource,
} from '@pylva/shared';
import { readBuilderContext } from '@/lib/auth/builder-context';
import { costSources } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';

const REFRESH_AFTER_MS = 60_000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({
        slug: costSources.slug,
        display_name: costSources.display_name,
        tracking_status: costSources.tracking_status,
        matchers: costSources.matchers,
        metric: costSources.metric,
        unit: costSources.unit,
        default_metric_value: costSources.default_metric_value,
        approved_at: costSources.approved_at,
        created_at: costSources.created_at,
      })
      .from(costSources)
      .where(
        and(
          eq(costSources.builder_id, ctx.builderId),
          eq(costSources.source_type, 'non_llm_manual'),
          inArray(costSources.tracking_status, [
            CostSourceTrackingStatus.TRACKED,
            CostSourceTrackingStatus.IGNORED,
          ]),
        ),
      ),
  );

  const sources: NonLlmPolicySource[] = rows.map((row) => ({
    slug: row.slug,
    display_name: row.display_name,
    status: row.tracking_status as NonLlmPolicySource['status'],
    matchers: row.matchers ?? [row.slug],
    metric: row.metric,
    unit: row.unit,
    default_metric_value:
      row.default_metric_value === null ? null : Number(row.default_metric_value),
  }));

  const latest = rows
    .map((row) => row.approved_at ?? row.created_at)
    .filter((date): date is Date => date instanceof Date)
    .map((date) => date.getTime())
    .reduce((max, value) => Math.max(max, value), 0);

  const body: NonLlmPolicyResponse = {
    version: `${sources.length}:${latest}`,
    refresh_after_ms: REFRESH_AFTER_MS,
    unknown_behavior: 'discover_only',
    sources,
  };

  return NextResponse.json(body);
}
