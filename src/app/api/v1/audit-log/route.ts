// v2 — GET /api/v1/audit-log.
//
// Per remaining-implementation-plan.md O13 the audit-log UI was
// deferred to v2; this is the v2 read API. Owner-only — audit logs
// can leak sensitive cross-user activity, so members don't see them.
//
// Filters: action, resource_type, resource_id, actor_user_id, date
// range. Pagination via `cursor` (audit_log.id is bigserial; we page
// on (timestamp DESC, id DESC) and round-trip the cursor as
// `${ts.toISOString()}_${id}`).

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, desc, eq, gte, lt, or, lte, sql } from 'drizzle-orm';
import { ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { withRLS } from '@/lib/db/rls';
import { auditLog as auditLogTable, users } from '@/lib/db/schema';
import { authError, validationError } from '@/lib/errors';

const PAGE_SIZE = 50;

interface CursorParts {
  ts: Date;
  id: number;
}

function decodeCursor(raw: string | null): CursorParts | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf('_');
  if (idx < 0) return null;
  const tsRaw = raw.slice(0, idx);
  const idRaw = raw.slice(idx + 1);
  const ts = new Date(tsRaw);
  const id = Number(idRaw);
  if (Number.isNaN(ts.getTime()) || !Number.isFinite(id)) return null;
  return { ts, id };
}

function encodeCursor(ts: Date, id: number): string {
  return `${ts.toISOString()}_${id}`;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const resourceType = url.searchParams.get('resource_type');
  const resourceId = url.searchParams.get('resource_id');
  const actorUserId = url.searchParams.get('actor_user_id');
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const cursorRaw = url.searchParams.get('cursor');

  const fromDate = fromRaw ? new Date(fromRaw) : null;
  const toDate = toRaw ? new Date(toRaw) : null;
  if (fromDate && Number.isNaN(fromDate.getTime()))
    return validationError('Invalid `from` date', 'from');
  if (toDate && Number.isNaN(toDate.getTime())) return validationError('Invalid `to` date', 'to');

  const cursor = decodeCursor(cursorRaw);

  const conditions = [eq(auditLogTable.builder_id, ctx.builderId)];
  if (action) conditions.push(eq(auditLogTable.action, action));
  if (resourceType) conditions.push(eq(auditLogTable.resource_type, resourceType));
  if (resourceId) conditions.push(eq(auditLogTable.resource_id, resourceId));
  if (actorUserId) conditions.push(eq(auditLogTable.actor_user_id, actorUserId));
  if (fromDate) conditions.push(gte(auditLogTable.timestamp, fromDate));
  if (toDate) conditions.push(lte(auditLogTable.timestamp, toDate));
  if (cursor) {
    // (timestamp, id) < (cursor.ts, cursor.id) for stable pagination.
    conditions.push(
      or(
        lt(auditLogTable.timestamp, cursor.ts),
        and(eq(auditLogTable.timestamp, cursor.ts), lt(auditLogTable.id, cursor.id)),
      )!,
    );
  }

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({
        id: auditLogTable.id,
        actor_type: auditLogTable.actor_type,
        actor_id: auditLogTable.actor_id,
        actor_user_id: auditLogTable.actor_user_id,
        action: auditLogTable.action,
        resource_type: auditLogTable.resource_type,
        resource_id: auditLogTable.resource_id,
        details: auditLogTable.details,
        ip_address: auditLogTable.ip_address,
        timestamp: auditLogTable.timestamp,
        // Left-join user email so the UI can show "alice@x.com" instead
        // of an opaque actor_user_id UUID. Stays a single round-trip.
        actor_email: sql<string | null>`(
          SELECT email FROM users
          WHERE users.id = ${auditLogTable.actor_user_id}
          LIMIT 1
        )`,
      })
      .from(auditLogTable)
      .where(and(...conditions))
      .orderBy(desc(auditLogTable.timestamp), desc(auditLogTable.id))
      .limit(PAGE_SIZE + 1),
  );
  // unused ref so the import isn't pruned (the inline subquery above
  // could be rewritten as a leftJoin once Drizzle's leftJoin mixes
  // cleanly with the typed select shape we need).
  void users;

  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.timestamp, last.id) : null;

  return NextResponse.json({
    entries: page.map((r) => ({
      id: r.id,
      actor_type: r.actor_type,
      actor_id: r.actor_id,
      actor_user_id: r.actor_user_id,
      actor_email: r.actor_email,
      action: r.action,
      resource_type: r.resource_type,
      resource_id: r.resource_id,
      details: r.details,
      ip_address: r.ip_address,
      timestamp: r.timestamp.toISOString(),
    })),
    next_cursor: nextCursor,
  });
}

// Silence unused-import warning when ErrorCode/authError aren't reached
// on the happy path.
void ErrorCode;
void authError;
