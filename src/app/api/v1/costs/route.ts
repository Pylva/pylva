// B2a T1 — GET /api/v1/costs
// Thin JSON wrapper over dashboard-queries for client-side re-fetch on filter
// changes. Reads builder_id from middleware header (I-T1-1 — never from query).
// Pre-parses date range. Production reads only real events; demo rows are
// not auto-shown (frontend launch §5).

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { getOverview, getTopEndUsers } from '@/lib/clickhouse/dashboard-queries';
import { apiError, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'api.costs' });

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const rangeParsed = parseRange(searchParams);
  if (rangeParsed instanceof NextResponse) return rangeParsed;

  let overview: Awaited<ReturnType<typeof getOverview>>;
  let topUsers: Awaited<ReturnType<typeof getTopEndUsers>>;
  try {
    [overview, topUsers] = await Promise.all([
      getOverview(ctx.builderId, rangeParsed, { includeDemo: false }),
      getTopEndUsers(ctx.builderId, rangeParsed, 5, { includeDemo: false }),
    ]);
  } catch (err) {
    log.warn(
      {
        builder_id: ctx.builderId,
        error: err instanceof Error ? err.message : String(err),
      },
      'cost summary unavailable',
    );
    return apiError(
      503,
      'api_error',
      ErrorCode.INTERNAL_ERROR,
      'Usage data is temporarily unavailable',
    );
  }

  return NextResponse.json({
    overview,
    top_end_users: topUsers,
    demo_only: false,
  });
}

export function parseRange(searchParams: URLSearchParams): { from: Date; to: Date } | NextResponse {
  const fromRaw = searchParams.get('from');
  const toRaw = searchParams.get('to');
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 86_400_000);
  if (Number.isNaN(from.getTime())) return validationError('Invalid "from" date', 'from');
  if (Number.isNaN(to.getTime())) return validationError('Invalid "to" date', 'to');
  if (from > to) return validationError('"from" must be earlier than "to"', 'from');
  return { from, to };
}
