// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — POST/GET /api/cron/purge-invoice-idempotency
//
// Daily at 00:15 UTC. CRON_SECRET-guarded. D12 TTL = 24h.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { authError, internalError } from '@/lib/errors';
import { verifyCronSecret } from '@/lib/cron/auth';
import { purgeInvoiceIdempotency } from '@/lib/billing/purge-invoice-idempotency';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'cron.purge-invoice-idempotency' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }
  try {
    const result = await purgeInvoiceIdempotency({ now: new Date() });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'purge-invoice-idempotency crashed');
    return internalError('purge-invoice-idempotency crashed');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
