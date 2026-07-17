import { ErrorCode } from '@pylva/shared';
import { NextResponse, type NextRequest } from 'next/server.js';
import { allScannedBuildersFailed } from '../../../../lib/cron/run-result.js';
import { verifyCronSecret } from '../../../../lib/cron/auth.js';
import { runBudgetReservationExpiry } from '../../../../lib/budget-control/expiry-runner.js';
import { authError, internalError } from '../../../../lib/errors.js';
import { logger } from '../../../../lib/logger.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = logger.child({ module: 'cron.expire-budget-reservations' });

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return noStore(authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET'));
  }

  try {
    // The reserve kill switch stops new controlled holds, but it must not
    // strand holds that already exist. Expiry is authenticated lifecycle
    // maintenance and therefore continues while new control is disabled.
    const result = await runBudgetReservationExpiry();
    if (allScannedBuildersFailed(result)) {
      log.error(result, 'budget reservation expiry failed for all scanned builders');
      return noStore(internalError('budget reservation expiry failed for all scanned builders'));
    }
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    log.error(
      { error_type: error instanceof Error ? error.name : 'UnknownError' },
      'budget reservation expiry cron crashed',
    );
    return noStore(internalError('budget reservation expiry cron crashed'));
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
