// POST/GET /api/cron/ensure-audit-partitions.
//
// The partition manager that migration 032's comment ("the partition-manager
// cron (existing infra) will append more") assumed existed but was never
// built. audit_log is RANGE-partitioned by timestamp; once the finite,
// migration-seeded partition runway is exhausted, every audit_log INSERT
// fails — and because audit writes share the business write's RLS transaction,
// that 500s every state-changing API call. This cron keeps a rolling window
// of monthly partitions ahead of NOW(), idempotently.
//
// EventBridge schedule: daily (cheap; the bounded database function is a no-op
// once the month's exact partition exists). Daily — rather than monthly — means a
// missed tick or boundary timezone skew can never leave the table without a
// partition for "today".

import { NextResponse, type NextRequest } from 'next/server.js';
import { sql } from 'drizzle-orm';
import { ErrorCode } from '@pylva/shared';
import { db } from '@/lib/db/client';
import { unwrapRows } from '@/lib/db/query-utils';
import { authError, internalError } from '@/lib/errors';
import { verifyCronSecret } from '@/lib/cron/auth';
import { logger } from '@/lib/logger';
import { auditLogPartitionSpecs, isValidPartitionSpec } from '@/lib/db/audit-partitions';

const log = logger.child({ module: 'cron.ensure-audit-partitions' });

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function run(): Promise<NextResponse> {
  try {
    const specs = auditLogPartitionSpecs(new Date());

    let created = 0;
    let existing = 0;
    let failed = 0;
    let invalid = 0;
    for (const spec of specs) {
      // Keep the application-side shape check as defense in depth. The bounded
      // database function independently derives and validates the identifier
      // and bounds from this bound month-start value.
      if (!isValidPartitionSpec(spec)) {
        invalid++;
        log.error({ partition: spec.name }, 'refusing malformed audit_log partition spec');
        continue;
      }
      try {
        // Migration 054 owns this bounded SECURITY DEFINER function with the
        // fixed general-app owner role. Calling it instead of issuing DDL as
        // the login keeps every new partition group-owned and validates the
        // exact parent, historical calendar-zone month bounds, and bounded
        // current-plus-12-UTC-month request runway.
        const result = await db.execute<{ created: boolean }>(sql`
          SELECT public.pylva_ensure_audit_log_partition(
            ${spec.from}::date
          ) AS created
        `);
        const wasCreated = unwrapRows<{ created: boolean }>(result)[0]?.created === true;
        if (wasCreated) created++;
        else existing++;
      } catch (err) {
        failed++;
        log.warn(
          {
            partition: spec.name,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to ensure audit_log partition',
        );
      }
    }

    const requested = specs.length;
    const ensured = created + existing;
    const result = { requested, ensured, created, existing, failed, invalid };

    // Any spec left unensured shrinks the partition runway; once it runs out,
    // every audit_log INSERT — and with it every state-changing API call —
    // 500s. Returning 200 here recorded an EventBridge success, so a
    // persistently failing CREATE never retried and never alarmed. Report
    // failure instead; the run is idempotent, so retries are safe.
    if (failed > 0 || invalid > 0) {
      log.error(result, 'ensure-audit-partitions left partitions missing');
      return noStore(
        internalError(`ensure-audit-partitions ensured ${ensured} of ${requested} partitions`),
      );
    }

    log.info(result, 'audit_log partition ensure complete');
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'ensure-audit-partitions crashed');
    return noStore(internalError('ensure-audit-partitions crashed'));
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request))
    return noStore(authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET'));
  return run();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request))
    return noStore(authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET'));
  return run();
}
