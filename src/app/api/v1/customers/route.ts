// B2a T1 — /api/v1/customers
// GET: list end-users (with cost summary, paginated).
// POST: create an end-user (upsert by external_id).
//
// This is the dashboard-audience CRUD path. Telemetry auto-creates customers
// via the ingest route; this endpoint is for manual curation.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { and, desc, eq, ilike } from 'drizzle-orm';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { checkCustomerLimitInTransaction, tierUsageHeader } from '@/lib/auth/tier-enforcement';
import { getBuilderTierForShare, lockCustomerLimit } from '@/lib/db/advisory-locks';
import { withRLS } from '@/lib/db/rls';
import { customers } from '@/lib/db/schema';
import { notFoundError, validationError } from '@/lib/errors';
import { getCustomerCostSummary } from '@/lib/clickhouse/dashboard-queries';
import { parseRange } from '../costs/route';
import { logger } from '@/lib/logger';
import { customerIdSchema, ErrorCode } from '@pylva/shared';

const log = logger.child({ module: 'api.customers' });

const CreateBody = v.object({
  // Shared charset (B12): telemetry events and rule targeting both validate
  // against customerIdSchema, so accepting a looser id here created
  // customers that could never receive events or rules — dead rows the
  // dashboard shows but no traffic can ever attribute to.
  external_id: v.pipe(
    customerIdSchema,
    v.description('alphanumeric, underscore, or hyphen; max 255 chars'),
  ),
  name: v.optional(v.pipe(v.string(), v.maxLength(255))),
  email: v.optional(v.pipe(v.string(), v.email())),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const range = parseRange(searchParams);
  if (range instanceof NextResponse) return range;

  const search = searchParams.get('search') ?? '';
  const limit = Math.min(Number(searchParams.get('limit') ?? '100'), 500);
  const offset = Math.max(Number(searchParams.get('offset') ?? '0'), 0);

  // Fetch PG rows (names/emails) + CH summary; merge by external_id.
  const rowsPromise = withRLS(ctx.builderId, async (tx) => {
    const whereClause =
      search.length > 0
        ? and(eq(customers.builder_id, ctx.builderId), ilike(customers.external_id, `%${search}%`))
        : eq(customers.builder_id, ctx.builderId);
    return tx
      .select({
        id: customers.id,
        external_id: customers.external_id,
        name: customers.name,
        email: customers.email,
        created_at: customers.created_at,
      })
      .from(customers)
      .where(whereClause)
      .orderBy(desc(customers.created_at))
      .limit(limit)
      .offset(offset);
  });
  const summaryPromise = getCustomerCostSummary(ctx.builderId, range, {
    includeDemo: false,
    limit: 500,
  });
  const [rowsResult, summaryResult] = await Promise.allSettled([rowsPromise, summaryPromise]);

  if (rowsResult.status === 'rejected') throw rowsResult.reason;
  const rows = rowsResult.value;
  let summary: Awaited<ReturnType<typeof getCustomerCostSummary>> = [];
  let usageDataUnavailable = false;
  if (summaryResult.status === 'fulfilled') {
    summary = summaryResult.value;
  } else {
    usageDataUnavailable = true;
    log.warn(
      {
        builder_id: ctx.builderId,
        error:
          summaryResult.reason instanceof Error
            ? summaryResult.reason.message
            : String(summaryResult.reason),
      },
      'customer summary unavailable',
    );
  }

  // getCustomerCostSummary strips the composite prefix — keyed by external_id.
  const summaryById = new Map(summary.map((s) => [s.customer_id, s]));
  const merged = rows.map((row) => {
    const s = summaryById.get(row.external_id);
    return {
      id: row.id,
      external_id: row.external_id,
      name: row.name,
      email: row.email,
      created_at: row.created_at,
      total_spend_usd: s?.total_spend_usd ?? 0,
      event_count: s?.event_count ?? 0,
      last_seen_at: s?.last_seen_at ?? null,
    };
  });

  return NextResponse.json({
    customers: merged,
    limit,
    offset,
    ...(usageDataUnavailable ? { usage_data_unavailable: true } : {}),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(CreateBody, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  const updateSet = {
    ...(parsed.output.name !== undefined ? { name: parsed.output.name } : {}),
    ...(parsed.output.email !== undefined ? { email: parsed.output.email } : {}),
    updated_at: new Date(),
  };

  const result = await withRLS(ctx.builderId, async (tx) => {
    await lockCustomerLimit(tx, ctx.builderId);
    const freshTier = await getBuilderTierForShare(tx, ctx.builderId);
    if (freshTier === null) {
      return { builderMissing: true as const };
    }

    const existingRows = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.builder_id, ctx.builderId),
          eq(customers.external_id, parsed.output.external_id),
        ),
      )
      .limit(1);
    const customerExists = existingRows.length > 0;

    const customerLimit = await checkCustomerLimitInTransaction(tx, ctx.builderId, freshTier);
    if (!customerExists && !customerLimit.allowed) {
      return { builderMissing: false as const, customerLimit, inserted: null };
    }

    const rows = await tx
      .insert(customers)
      .values({
        builder_id: ctx.builderId,
        external_id: parsed.output.external_id,
        name: parsed.output.name ?? null,
        email: parsed.output.email ?? null,
      })
      .onConflictDoUpdate({
        target: [customers.builder_id, customers.external_id],
        set: updateSet,
      })
      .returning({ id: customers.id, external_id: customers.external_id });
    return {
      builderMissing: false as const,
      customerLimit,
      inserted: rows[0]!,
      customerExists,
    };
  });

  if (result.builderMissing) {
    return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');
  }

  if (result.inserted === null) {
    const response = result.customerLimit.response!;
    response.headers.set(
      'X-Pylva-Tier-Usage',
      tierUsageHeader(result.customerLimit.current, result.customerLimit.limit),
    );
    return response;
  }

  const usageCurrent = result.customerExists
    ? result.customerLimit.current
    : result.customerLimit.current + 1;

  return NextResponse.json(
    { customer: result.inserted },
    {
      headers: {
        'X-Pylva-Tier-Usage': tierUsageHeader(usageCurrent, result.customerLimit.limit),
      },
    },
  );
}
