import { NextResponse, type NextRequest } from 'next/server.js';
import { eq } from 'drizzle-orm';
import { ApiKeyScope, ErrorCode, resolveBuilderEntitlement } from '@pylva/shared';
import { readBuilderContext } from '@/lib/auth/builder-context';
import { limitsForEntitlement } from '@/lib/auth/workspace-limits';
import { env } from '@/lib/config';
import { withRLS } from '@/lib/db/rls';
import { builders } from '@/lib/db/schema';
import { internalError, notFoundError } from '@/lib/errors';
import { getEventCapUsage } from '@/lib/ingest/event-cap';
import { PYLVA_DOCS_URL } from '@/lib/public-links';

function declaresCanonicalPlanContract(contractVersion: string | undefined): boolean {
  if (contractVersion === undefined || !/^[0-9]{1,8}$/u.test(contractVersion)) {
    return false;
  }
  return Number(contractVersion) >= 2;
}

// Identity + plan check for API keys, so integrations (and the coding
// agents driving them) can verify a key end to end without dashboard access.
// Migration 048 made current keys universal. Persisted legacy scope values are
// display/audit data only, so this endpoint reports the effective scope.
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
        access_state: builders.access_state,
        entitlement_source: builders.entitlement_source,
      })
      .from(builders)
      .where(eq(builders.id, ctx.builderId))
      .limit(1),
  );

  const builder = rows[0];
  if (!builder) return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');

  const resolution = resolveBuilderEntitlement({
    plan: builder.tier,
    access_state: builder.access_state,
    entitlement_source: builder.entitlement_source,
  });
  if (!resolution.ok) {
    console.error(`[whoami] invalid workspace entitlement: ${resolution.reason}`);
    return internalError('Workspace entitlement configuration is invalid');
  }

  const entitlement = resolution.entitlement;
  const limits = limitsForEntitlement(entitlement);
  if (entitlement.has_product_access && limits === null) {
    console.error('[whoami] active workspace has no limits for this deployment mode');
    return internalError('Workspace entitlement configuration is invalid');
  }
  const cap = limits?.monthly_events ?? null;
  const limitsEnforced =
    env.ENABLE_EVENT_LIMITS && entitlement.has_product_access && limits !== null;
  const usage = limitsEnforced ? await getEventCapUsage(ctx.builderId) : null;
  const deprecatedTier =
    entitlement.has_product_access && entitlement.plan !== null ? entitlement.plan : null;
  const contractVersion = request.headers.get('x-pylva-contract-version')?.trim();
  const emitDeprecatedTier =
    deprecatedTier !== null && !declaresCanonicalPlanContract(contractVersion);
  if (emitDeprecatedTier) {
    const loggedContractVersion =
      contractVersion === undefined
        ? 'absent'
        : /^[0-9]{1,8}$/u.test(contractVersion)
          ? contractVersion
          : 'other';
    // A server cannot observe whether arbitrary JSON clients read one property.
    // Treat an absent/old contract declaration as legacy-field usage so the
    // removal gate is conservative and attributable to an authenticated key.
    // Bound untrusted header metadata before logging it.
    console.warn(
      `[whoami] deprecated_tier_alias_consumer builder_id=${ctx.builderId} key_id=${ctx.keyId} contract_version=${loggedContractVersion}`,
    );
  }

  // usage is null when limits are disabled, on unlimited plans, or on a
  // failed-open usage lookup; limits.enforced disambiguates for
  // callers deciding whether to self-throttle.
  return NextResponse.json(
    {
      org: {
        slug: builder.slug,
        name: builder.display_name ?? builder.name ?? builder.slug,
      },
      plan: entitlement.plan,
      access_state: entitlement.access_state,
      // Deprecated compatibility alias: never synthesize a paid value for a
      // provisional, suspended, self-hosted, legacy, or invalid workspace.
      ...(emitDeprecatedTier ? { tier: deprecatedTier } : {}),
      key: { id: ctx.keyId, scope: ApiKeyScope.UNIVERSAL },
      limits: {
        // Infinity is not representable in JSON; unlimited reports null.
        monthly_events: cap !== null && Number.isFinite(cap) ? cap : null,
        enforced: limitsEnforced,
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
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-Pylva-Contract-Version': '2',
      },
    },
  );
}
