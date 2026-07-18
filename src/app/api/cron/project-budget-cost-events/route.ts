import { ErrorCode } from '@pylva/shared';
import { NextResponse, type NextRequest } from 'next/server.js';
import { verifyCronSecret } from '../../../../lib/cron/auth.js';
import { authError, internalError } from '../../../../lib/errors.js';
import { logger } from '../../../../lib/logger.js';
import {
  budgetProjectionRunFailedSystemically,
  runBudgetCostEventProjection,
} from '../../../../lib/budget-projection/worker.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger.child({ module: 'cron.project-budget-cost-events' });

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function requiresOperatorAlarm(result: Awaited<ReturnType<typeof runBudgetCostEventProjection>>) {
  return (
    budgetProjectionRunFailedSystemically(result) ||
    result.high_attempt_rows > 0 ||
    result.exhausted_attempt_rows > 0 ||
    result.reconciliation_missing > 0 ||
    result.reconciliation_conflicts > 0 ||
    result.reconciliation_errors > 0
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return noStore(authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET'));
  }

  try {
    // Schedule this endpoint at least once per minute. A unique worker identity
    // is generated for every invocation, so overlapping EventBridge retries are
    // fenced by PostgreSQL leases rather than process-local coordination.
    const result = await runBudgetCostEventProjection();
    if (requiresOperatorAlarm(result)) {
      log.error(result, 'authoritative projection cycle requires operator attention');
      return noStore(internalError('authoritative projection cycle did not reconcile'));
    }
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    log.error(
      { error_type: error instanceof Error ? error.name : 'UnknownError' },
      'authoritative projection cron crashed',
    );
    return noStore(internalError('authoritative projection cron crashed'));
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}

export const __budgetProjectionRouteTesting = { requiresOperatorAlarm };
