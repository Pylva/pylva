// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.2 — GET /api/portal/overview.
// Public portal endpoint. Token required (Authorization: Bearer or
// ?token= query). Returns customer-scoped usage overview + breakdown.

import { NextResponse, type NextRequest } from 'next/server.js';
import { eq } from 'drizzle-orm';
import { VisibilityLevel } from '@pylva/shared';
import { authenticatePortalToken } from '@/lib/portal/auth';
import { withRLS } from '@/lib/db/rls';
import { portalConfigs } from '@/lib/db/schema';
import { checkPortalEntitlement } from '@/lib/portal/entitlement';
import {
  getPortalBreakdownByModel,
  getPortalOverview,
  resolvePortalRange,
  type PortalBreakdownRow,
} from '@/lib/portal/data';

export const runtime = 'nodejs';

function extractToken(request: NextRequest): string | null {
  const auth = request.headers.get('authorization') ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
  const url = new URL(request.url);
  return url.searchParams.get('token');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = extractToken(request);
  if (!token) {
    return NextResponse.json({ error: 'missing_token' }, { status: 401 });
  }

  const outcome = await authenticatePortalToken(token);
  if (outcome.kind === 'unauthenticated') {
    return NextResponse.json({ error: 'unauthenticated', reason: outcome.reason }, { status: 401 });
  }
  if (outcome.kind === 'expired') {
    return NextResponse.json({ error: 'expired', reason: outcome.reason }, { status: 401 });
  }
  if (outcome.kind === 'rate_limited') {
    return new NextResponse(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(outcome.retryAfterSec),
      },
    });
  }

  const ctx = outcome.ctx;
  const entitlement = await checkPortalEntitlement(ctx.builderId);
  if (entitlement) return entitlement;

  // The per-model breakdown is builder-confidential (it reveals which
  // providers/models power the product). Honor portal_configs.visibility_level
  // here exactly as the portal page does — AGGREGATE_ONLY (the schema default)
  // must NOT expose by_model, even to a customer hitting this JSON API directly.
  const [configRows, range] = await Promise.all([
    withRLS(ctx.builderId, async (tx) =>
      tx
        .select({ visibility_level: portalConfigs.visibility_level })
        .from(portalConfigs)
        .where(eq(portalConfigs.builder_id, ctx.builderId))
        .limit(1),
    ),
    resolvePortalRange(ctx.builderId, ctx.customerId),
  ]);
  const visibility = configRows[0]?.visibility_level ?? VisibilityLevel.AGGREGATE_ONLY;

  const [overview, byModel] = await Promise.all([
    getPortalOverview(ctx.builderId, ctx.customerId, range),
    visibility === VisibilityLevel.AGGREGATE_ONLY
      ? Promise.resolve([] as PortalBreakdownRow[])
      : getPortalBreakdownByModel(ctx.builderId, ctx.customerId, range),
  ]);

  return NextResponse.json({
    range: {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      source: range.source,
    },
    overview,
    breakdown: { by_model: byModel },
    session_expires_at: ctx.sessionExpiresAt.toISOString(),
  });
}
