// Track 1 PR 1.4 — POST/GET /api/cron/purge-dlq.
// EventBridge tick at 03:15 UTC. CRON_SECRET-guarded. 30-day fixed
// retention (O23). Idempotent: re-running the same day is a no-op once
// rows >30d are gone.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { authError, internalError } from '@/lib/errors';
import { purgeDlq } from '@/lib/alerts/dlq-retry';
import { verifyCronSecret } from '@/lib/cron/auth';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'cron.purge-dlq' });

async function run(): Promise<NextResponse> {
  try {
    const result = await purgeDlq();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'purge-dlq crashed');
    return internalError('purge-dlq crashed');
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request))
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  return run();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request))
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  return run();
}
