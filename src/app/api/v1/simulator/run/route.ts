import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { checkDashboardFeatureGate } from '@/lib/auth/dashboard-feature-gate';
import { simulatorRequestSchema } from '@/lib/simulator/validator';
import { runSimulation } from '@/lib/simulator/engine';
import { simulatorResultToCsv } from '@/lib/simulator/csv-export';
import { validationError } from '@/lib/errors';
import { env } from '@/lib/config';

export async function POST(request: NextRequest): Promise<NextResponse | Response> {
  if (!env.ENABLE_SIMULATOR) {
    return NextResponse.json(
      { error: { code: 'FEATURE_DISABLED', message: 'Cost simulator is currently disabled' } },
      { status: 503 },
    );
  }

  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const gateResult = await checkDashboardFeatureGate(ctx.builderId, 'simulator');
  if (gateResult) return gateResult;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(simulatorRequestSchema, body);
  if (!parsed.success) {
    const issue = parsed.issues[0];
    return validationError(
      issue?.message ?? 'Invalid simulator request',
      issue?.path
        ?.map((p) => (typeof p.key === 'string' ? p.key : ''))
        .filter(Boolean)
        .join('.') || 'body',
    );
  }

  const result = await runSimulation(ctx.builderId, ctx.builderId, parsed.output);

  const format = request.nextUrl.searchParams.get('format');
  if (format === 'csv') {
    const csv = simulatorResultToCsv(result);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="simulation-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json(result);
}
