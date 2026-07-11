// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — POST/GET /api/cron/generate-monthly-drafts
//
// Daily at 04:00 UTC (EventBridge). For each (builder, customer) whose
// billing_period ended in the last 24h, call the invoice generator. The
// generator handles auto-split, pricing-not-configured, capabilities gate,
// etc.; this route is a thin iterator.
//
// Guarded by CRON_SECRET bearer token.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { authError, internalError } from '@/lib/errors';
import { verifyCronSecret } from '@/lib/cron/auth';
import { generateMonthlyDrafts } from '@/lib/billing/monthly-drafts';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'cron.generate-monthly-drafts' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }
  try {
    const result = await generateMonthlyDrafts({ now: new Date() });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'generate-monthly-drafts crashed');
    return internalError('generate-monthly-drafts crashed');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
