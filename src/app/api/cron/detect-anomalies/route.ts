// POST /api/cron/detect-anomalies — hourly EventBridge tick. Bearer-
// guarded by CRON_SECRET; honors ENABLE_ADVANCED_RULES kill switch.
// Aliased to GET so the EventBridge HTTP-target schedule (which only
// emits the verb specified in `input.method`) can use either.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { env } from '../../../../lib/config.js';
import { authError, apiError, internalError } from '../../../../lib/errors.js';
import { detectAnomalies } from '../../../../lib/anomaly/runner.js';
import { allScannedBuildersFailed } from '../../../../lib/cron/run-result.js';
import { verifyCronSecret } from '../../../../lib/cron/auth.js';
import { logger } from '../../../../lib/logger.js';

const log = logger.child({ module: 'cron.detect-anomalies' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }
  if (!env.ENABLE_ADVANCED_RULES) {
    return apiError(
      503,
      'api_error',
      ErrorCode.FEATURE_NOT_AVAILABLE,
      'Advanced rules feature disabled',
    );
  }
  try {
    const result = await detectAnomalies({ now: new Date() });
    // Every builder failed → systemic outage (see allScannedBuildersFailed):
    // report failure so EventBridge retries + alarms instead of recording a
    // silent success that hides the outage.
    if (allScannedBuildersFailed(result)) {
      log.error(result, 'detect-anomalies cron: all builders failed — reporting failure');
      return internalError('detect-anomalies failed for all scanned builders');
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    log.error({ error: message }, 'detect-anomalies cron crashed');
    return internalError('detect-anomalies cron crashed');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
