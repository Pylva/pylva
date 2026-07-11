// Health check endpoint — public, no auth required

import { NextResponse } from 'next/server.js';
import { sql } from '../../../../lib/db/client.js';
import { getSchemaStatus } from '../../../../lib/db/schema-status.js';
import { clickhouse } from '../../../../lib/clickhouse/client.js';
import {
  checkClickHouseReadiness,
  failedClickHouseReadinessChecks,
} from '../../../../lib/clickhouse/readiness.js';
import { pingRedis } from '../../../../lib/redis/client.js';
import { env } from '../../../../lib/config.js';
import { logger } from '../../../../lib/logger.js';

const log = logger.child({ module: 'health.route' });

async function checkPg(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function checkCh(): Promise<boolean> {
  const result = await checkClickHouseReadiness(clickhouse);
  if (!result.ready) {
    log.warn(
      {
        failed_checks: failedClickHouseReadinessChecks(result).map((check) => ({
          name: check.name,
          missing: check.missing,
          message: check.message,
        })),
      },
      'clickhouse readiness check failed',
    );
  }
  return result.ready;
}

export async function GET() {
  const [pgUp, chUp, redisUp, schema] = await Promise.all([
    checkPg(),
    checkCh(),
    pingRedis(),
    getSchemaStatus(),
  ]);

  const services = {
    postgresql: pgUp ? ('up' as const) : ('down' as const),
    clickhouse: chUp ? ('up' as const) : ('down' as const),
    redis: redisUp ? ('up' as const) : ('down' as const),
  };

  const allUp = pgUp && chUp && redisUp;

  // Public endpoint — expose only aggregate status + the deployed build SHA
  // (no internal details). `version` lets the verify-deploy skill confirm the
  // live image matches origin/main; "unknown" outside CI-built images.
  return NextResponse.json(
    {
      status: allUp ? 'healthy' : 'degraded',
      version: env.SENTRY_RELEASE,
      services,
      schema,
    },
    {
      status: allUp ? 200 : 503,
    },
  );
}
