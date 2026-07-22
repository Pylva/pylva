// POST /api/cron/pricing-sync — daily LiteLLM sync (B1 — D29).
// Guarded by CRON_SECRET bearer token. On the third consecutive LiteLLM
// failure, the route automatically invokes syncFromSnapshot() once. It also
// exposes ?fallback=snapshot for manual recovery.

import { NextResponse, type NextRequest } from 'next/server.js';
import { authError, internalError } from '../../../../lib/errors.js';
import { ErrorCode } from '@pylva/shared';
import { runLitellmSync, syncFromSnapshot } from '../../../../lib/pricing/litellm-sync.js';
import { runBackupPriceWatcher } from '../../../../lib/rules/backup-price-watcher.js';
import { verifyCronSecret } from '../../../../lib/cron/auth.js';
import { logger } from '../../../../lib/logger.js';

const log = logger.child({ module: 'cron.pricing-sync' });

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }

  const url = new URL(request.url);
  const fallback = url.searchParams.get('fallback');

  try {
    const manualSnapshotFallback = fallback === 'snapshot';
    let result = manualSnapshotFallback ? await syncFromSnapshot() : await runLitellmSync();

    // The committed snapshot is the automatic DR path after three consecutive
    // LiteLLM failures. Trigger only at attempt 3: if the snapshot itself is
    // invalid, its aborted log row advances the streak and later cron runs must
    // not loop on the same broken fallback.
    if (!manualSnapshotFallback && result.status === 'aborted' && result.attempt_number === 3) {
      result = await syncFromSnapshot();
    }
    // D31: after the pricing table refreshes, sweep active failover
    // rules for backup-model price drift. Runs unconditionally (also on
    // snapshot fallback) — even a stale-snapshot sync can trigger a
    // legitimate alert if the previous run never got to the watcher.
    // Errors here must not roll back the pricing sync result.
    let watcher = null;
    try {
      watcher = await runBackupPriceWatcher();
    } catch (err) {
      log.warn(
        {
          error: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err),
        },
        'backup-price watcher threw; pricing-sync result still returned',
      );
    }
    return NextResponse.json({ ...result, backup_price_watcher: watcher }, { status: 200 });
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'pricing sync crashed');
    return internalError('pricing sync crashed');
  }
}

// Vercel Cron also supports GET; mirror POST so both work.
export async function GET(request: NextRequest): Promise<NextResponse> {
  return POST(request);
}
