// B2a — POST /api/v1/auth/switch-org
// Switches the active org for the current user. Revokes the old JWT,
// mints a new one with the target builder_id + role + tier, returns the
// destination slug so the client can navigate.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { setDashboardSessionCookies, withJwtAuth } from '@/lib/auth/middleware';
import { revokeJwt, signJwt } from '@/lib/auth/jwt';
import { switchActiveOrg } from '@/lib/auth/org';
import { JwtAudience } from '@pylva/shared';
import { authError, notFoundError, validationError } from '@/lib/errors';
import { ErrorCode } from '@pylva/shared';

const BodySchema = v.object({
  builder_id: v.pipe(v.string(), v.uuid()),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = await withJwtAuth(request, JwtAudience.DASHBOARD);
  if (authResult instanceof NextResponse) return authResult;
  const { context } = authResult;
  if (!context.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context in session');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(BodySchema, body);
  if (!parsed.success)
    return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'builder_id');

  const target = await switchActiveOrg({
    userId: context.userId,
    builderId: parsed.output.builder_id,
  });
  if (!target) return notFoundError(ErrorCode.NOT_FOUND, 'Builder not found or not a member');

  // Sign first: if key access fails, leave the current family usable instead
  // of stranding the browser on a revoked cookie.
  const jwt = await signJwt({
    builder_id: target.builderId,
    audience: JwtAudience.DASHBOARD,
    user_id: context.userId,
    org_slug: target.slug,
    role: target.role,
    tier: target.tier,
  });

  // Revoke the old session family so every sliding-refresh branch dies.
  try {
    await revokeJwt(context.revocationId, JwtAudience.DASHBOARD, 24 * 60 * 60);
  } catch {
    // Non-fatal: the coherent replacement session still becomes active.
  }

  const response = NextResponse.json({
    ok: true,
    slug: target.slug,
    redirect_to: `/o/${target.slug}/dashboard`,
  });
  setDashboardSessionCookies(response, {
    token: jwt,
    userId: context.userId,
    orgSlug: target.slug,
  });
  return response;
}
