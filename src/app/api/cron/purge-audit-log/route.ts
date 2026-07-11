// Track 3 PR 3.1 — POST/GET /api/cron/purge-audit-log.
// Per internal design notes (O35).
//
// Drops audit_log partitions older than 365 days. Idempotent — re-runs
// on the same day are no-ops. EventBridge schedule: weekly (per spec
// §4.9 retention semantics; partitioned tables don't need daily sweeps).

import { NextResponse, type NextRequest } from 'next/server.js';
import { sql } from 'drizzle-orm';
import { ErrorCode } from '@pylva/shared';
import { db } from '@/lib/db/client';
import { unwrapRows } from '@/lib/db/query-utils';
import { authError, internalError } from '@/lib/errors';
import { verifyCronSecret } from '@/lib/cron/auth';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'cron.purge-audit-log' });

const RETENTION_DAYS = 365;

async function run(): Promise<NextResponse> {
  try {
    // Find partitions whose upper-bound date is older than the retention
    // window, then DETACH + DROP. This is much cheaper than DELETE on a
    // partitioned table.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    const cutoffMonthStr = `${cutoff.getUTCFullYear()}m${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;

    const partitions = await db.execute<{ partition_name: string }>(sql`
      SELECT inhrelid::regclass::text AS partition_name
      FROM pg_inherits
      WHERE inhparent = 'audit_log'::regclass
    `);
    // postgres-js returns a Result that `extends Array` (rows are the array
    // elements) with NO `.rows` property — reading `.rows` yields undefined,
    // which made `for (const r of rows)` throw and the cron 500 every run,
    // so NO expired partition was ever dropped. unwrapRows normalizes both
    // adapter shapes.
    const rows = unwrapRows<{ partition_name: string }>(partitions);

    let dropped = 0;
    for (const r of rows) {
      // partition_name format: audit_log_yYYYYmMM
      const m = r.partition_name.match(/audit_log_y(\d{4})m(\d{2})/);
      if (!m) continue;
      const [, yyyy, mm] = m;
      const partMonth = `${yyyy}m${mm}`;
      if (partMonth >= cutoffMonthStr) continue;
      try {
        await db.execute(sql`DROP TABLE IF EXISTS ${sql.raw(`"${r.partition_name}"`)}`);
        dropped++;
      } catch (err) {
        log.warn(
          {
            partition: r.partition_name,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to drop expired audit_log partition',
        );
      }
    }

    log.info({ dropped, cutoffMonthStr }, 'audit_log purge complete');
    return NextResponse.json({ dropped, retention_days: RETENTION_DAYS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'purge-audit-log crashed');
    return internalError('purge-audit-log crashed');
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
