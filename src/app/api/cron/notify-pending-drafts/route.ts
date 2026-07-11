// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — POST/GET /api/cron/notify-pending-drafts
//
// Daily at 09:00 UTC (EventBridge). CRON_SECRET-guarded.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { authError, internalError } from '@/lib/errors';
import { verifyCronSecret } from '@/lib/cron/auth';
import { notifyPendingDrafts } from '@/lib/billing/notify-pending-drafts';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'cron.notify-pending-drafts' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }
  try {
    const result = await notifyPendingDrafts({ now: new Date() });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'notify-pending-drafts crashed');
    return internalError('notify-pending-drafts crashed');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
