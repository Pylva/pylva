// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.1 — POST/GET /api/v1/portal/links.
// Owner-only mint per §3 security defaults.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ErrorCode,
  JwtAudience,
  PortalLinkStatus,
  PortalLinkType,
  type Role as RoleType,
} from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { signJwt } from '@/lib/auth/jwt';
import { withRLS } from '@/lib/db/rls';
import { portalLinks, customers } from '@/lib/db/schema';
import { checkPortalEntitlement } from '@/lib/portal/entitlement';
import { authError, notFoundError, validationError } from '@/lib/errors';
import { isUuid } from '@/lib/validation/uuid';

const CreateSchema = v.object({
  customer_id: v.pipe(v.string(), v.uuid()),
  link_type: v.optional(
    v.picklist([PortalLinkType.STANDARD, PortalLinkType.SINGLE_USE]),
    PortalLinkType.STANDARD,
  ),
});

const STANDARD_TTL_HOURS = 24;
const SINGLE_USE_TTL_HOURS = 24;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const entitlement = await checkPortalEntitlement(ctx.builderId);
  if (entitlement) return entitlement;

  const url = new URL(request.url);
  const customerId = url.searchParams.get('customer_id');
  if (customerId && !isUuid(customerId)) {
    return validationError('Invalid customer_id', 'customer_id');
  }

  const rows = await withRLS(ctx.builderId, async (tx) => {
    const conditions = [eq(portalLinks.builder_id, ctx.builderId)];
    if (customerId) conditions.push(eq(portalLinks.customer_id, customerId));
    return tx
      .select({
        id: portalLinks.id,
        customer_id: portalLinks.customer_id,
        jti: portalLinks.jti,
        link_type: portalLinks.link_type,
        status: portalLinks.status,
        expires_at: portalLinks.expires_at,
        first_used_at: portalLinks.first_used_at,
        revoked_at: portalLinks.revoked_at,
        created_by: portalLinks.created_by,
        created_at: portalLinks.created_at,
      })
      .from(portalLinks)
      .where(and(...conditions))
      .orderBy(desc(portalLinks.created_at))
      .limit(200);
  });

  return NextResponse.json({ links: rows });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;
  const entitlement = await checkPortalEntitlement(ctx.builderId);
  if (entitlement) return entitlement;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(CreateSchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  // Confirm the customer belongs to this builder before issuing a link.
  const customer = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(eq(customers.id, parsed.output.customer_id), eq(customers.builder_id, ctx.builderId)),
      )
      .limit(1),
  );
  if (customer.length === 0) return notFoundError(ErrorCode.NOT_FOUND, 'Customer not found');

  const ttlHours =
    parsed.output.link_type === PortalLinkType.SINGLE_USE
      ? SINGLE_USE_TTL_HOURS
      : STANDARD_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  const token = await signJwt({
    builder_id: ctx.builderId,
    audience: JwtAudience.PORTAL,
    expiresIn: `${ttlHours}h`,
    customer_id: parsed.output.customer_id,
  });

  // Pull the jti out of the freshly minted JWT — signJwt sets it via
  // crypto.randomUUID(); decoding without verifying is safe here because
  // we just signed it ourselves.
  const [, payloadB64] = token.split('.');
  if (!payloadB64) return validationError('Failed to mint portal token', 'token');
  const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    jti?: string;
  };
  const jti = decoded.jti ?? crypto.randomUUID();

  const userId = ctx.userId;
  const [created] = await withRLS(ctx.builderId, async (tx) =>
    tx
      .insert(portalLinks)
      .values({
        builder_id: ctx.builderId,
        customer_id: parsed.output.customer_id,
        jti,
        token_hash: hashToken(token),
        link_type: parsed.output.link_type,
        status: PortalLinkStatus.ACTIVE,
        expires_at: expiresAt,
        created_by: userId,
      })
      .returning(),
  );

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.PORTAL_LINK_CREATE,
      resource_type: 'portal_link',
      resource_id: created!.id,
      details: { customer_id: parsed.output.customer_id, link_type: parsed.output.link_type },
    });
  });

  // Token is returned exactly once. Subsequent GETs only expose metadata.
  return NextResponse.json(
    {
      link: {
        id: created!.id,
        jti: created!.jti,
        link_type: created!.link_type,
        expires_at: created!.expires_at,
        url: `/portal?token=${encodeURIComponent(token)}`,
        token,
      },
    },
    { status: 201 },
  );
}
