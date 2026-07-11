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
// EventBridge schedule: daily (cheap; CREATE TABLE IF NOT EXISTS is a no-op
// once the month's partition exists). Daily — rather than monthly — means a
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

interface ExistingPartitionRow {
  partition_name: string;
  [key: string]: unknown;
}

function isDuplicateTableError(err: unknown): boolean {
  return (err as { code?: unknown } | undefined)?.code === '42P07';
}

async function run(): Promise<NextResponse> {
  try {
    const specs = auditLogPartitionSpecs(new Date());

    const existingRows = await db.execute<ExistingPartitionRow>(sql`
      SELECT child.relname AS partition_name
      FROM pg_inherits
      JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE pg_inherits.inhparent = 'audit_log'::regclass
    `);
    const existingPartitions = new Set(
      unwrapRows<ExistingPartitionRow>(existingRows).map((row) => row.partition_name),
    );

    let created = 0;
    let existing = 0;
    let failed = 0;
    let invalid = 0;
    for (const spec of specs) {
      // Postgres cannot bind identifiers or partition bounds as parameters, so
      // these are interpolated via sql.raw. auditLogPartitionSpecs produces them
      // from a server clock (never user input); re-validate the exact shape here
      // before interpolating so the injection surface stays closed even if a
      // future caller feeds an untrusted spec.
      if (!isValidPartitionSpec(spec)) {
        invalid++;
        log.error({ partition: spec.name }, 'refusing malformed audit_log partition spec');
        continue;
      }
      if (existingPartitions.has(spec.name)) {
        existing++;
        continue;
      }
      try {
        await db.execute(
          sql`${sql.raw(
            `CREATE TABLE "${spec.name}" PARTITION OF audit_log ` +
              `FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`,
          )}`,
        );
        created++;
        existingPartitions.add(spec.name);
      } catch (err) {
        if (isDuplicateTableError(err)) {
          existing++;
          existingPartitions.add(spec.name);
          continue;
        }
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
      return internalError(`ensure-audit-partitions ensured ${ensured} of ${requested} partitions`);
    }

    log.info(result, 'audit_log partition ensure complete');
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'ensure-audit-partitions crashed');
    return internalError('ensure-audit-partitions crashed');
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
