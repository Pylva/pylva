// B2a T1 — GET /api/v1/traces?customer_id=&limit=
// Lists recent traces for the builder. Optionally filtered by end-user.

import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { getRecentTraces } from '@/lib/clickhouse/dashboard-queries';
import { parseRange } from '../costs/route';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const range = parseRange(searchParams);
  if (range instanceof NextResponse) return range;

  // Use || so empty-string param is treated as absent (not a bare-string filter).
  const customerId = searchParams.get('customer_id') || undefined;
  const rawLimit = parseInt(searchParams.get('limit') ?? '50', 10);
  const limit = Math.min(Number.isNaN(rawLimit) ? 50 : rawLimit, 200);

  const traces = await getRecentTraces(ctx.builderId, range, {
    includeDemo: false,
    ...(customerId ? { customerId } : {}),
    limit,
  });

  return NextResponse.json({ traces });
}
