import { NextResponse, type NextRequest } from 'next/server.js';
import { eq } from 'drizzle-orm';
import { ApiKeyScope, BuilderTier, ErrorCode, isBuilderTier, TIER_LIMITS } from '@pylva/shared';
import { readBuilderContext } from '@/lib/auth/builder-context';
import { env } from '@/lib/config';
import { withRLS } from '@/lib/db/rls';
import { builders } from '@/lib/db/schema';
import { notFoundError } from '@/lib/errors';
import { getEventCapUsage } from '@/lib/ingest/event-cap';
import { PYLVA_DOCS_URL } from '@/lib/public-links';

// Identity + plan check for Agent SDK keys, so integrations (and the coding
// agents driving them) can verify a key end to end without dashboard access.
// Middleware enforces AGENT_SDK scope before this handler runs; legacy
// persisted 'telemetry' keys reach here via the scope alias and are reported
// with their effective scope, agent_sdk.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({
        slug: builders.slug,
        name: builders.name,
        display_name: builders.display_name,
        tier: builders.tier,
      })
      .from(builders)
      .where(eq(builders.id, ctx.builderId))
      .limit(1),
  );

  const builder = rows[0];
  if (!builder) return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');

  const tier = isBuilderTier(builder.tier) ? builder.tier : BuilderTier.FREE;
  const cap = TIER_LIMITS[tier].monthly_events;
  const usage = await getEventCapUsage(ctx.builderId);

  // usage is null when limits are disabled (self-host default), on unlimited
  // tiers, or on a failed-open lookup; limits.enforced disambiguates for
  // callers deciding whether to self-throttle.
  return NextResponse.json(
    {
      org: {
        slug: builder.slug,
        name: builder.display_name ?? builder.name ?? builder.slug,
      },
      tier,
      key: { id: ctx.keyId, scope: ApiKeyScope.AGENT_SDK },
      limits: {
        // Infinity is not representable in JSON; unlimited reports null.
        monthly_events: Number.isFinite(cap) ? cap : null,
        enforced: env.ENABLE_EVENT_LIMITS,
      },
      usage:
        usage === null
          ? null
          : {
              monthly_events_used: usage.monthly_events_used,
              monthly_events_limit: usage.monthly_events_limit,
              window_start: usage.window_start.toISOString(),
              window_end: usage.window_end.toISOString(),
              window_source: usage.window_source,
            },
      docs_url: PYLVA_DOCS_URL,
      agent_setup_url: `${PYLVA_DOCS_URL}/setup-with-ai.md`,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
