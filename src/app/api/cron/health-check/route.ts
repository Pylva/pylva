// POST /api/cron/health-check — hourly EventBridge tick (b3 plan §9, D31/D32).
// Guarded by CRON_SECRET bearer; honors ENABLE_COST_SOURCES kill switch.
// Iterates every builder with cost_sources rows, runs the silence + cost-drop
// detectors, fires INSTRUMENTATION_SILENCE / INSTRUMENTATION_COST_DROP alerts,
// and updates cost_sources.status so the dashboard health badges reflect truth.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { env } from '../../../../lib/config.js';
import { authError, apiError, internalError } from '../../../../lib/errors.js';
import { runHealthCheck } from '../../../../lib/health/runner.js';
import { allScannedBuildersFailed } from '../../../../lib/cron/run-result.js';
import { verifyCronSecret } from '../../../../lib/cron/auth.js';
import { logger } from '../../../../lib/logger.js';

const log = logger.child({ module: 'cron.health-check' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }
  if (!env.ENABLE_COST_SOURCES) {
    return apiError(
      503,
      'api_error',
      ErrorCode.FEATURE_NOT_AVAILABLE,
      'Cost sources feature disabled',
    );
  }
  try {
    const result = await runHealthCheck({ now: new Date() });
    // Every builder failed → systemic outage (see allScannedBuildersFailed):
    // report failure so EventBridge retries + alarms instead of recording a
    // silent success that hides the outage.
    if (allScannedBuildersFailed(result)) {
      log.error(result, 'health-check cron: all builders failed — reporting failure');
      return internalError('health-check failed for all scanned builders');
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'health-check cron crashed');
    return internalError('health-check cron crashed');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
