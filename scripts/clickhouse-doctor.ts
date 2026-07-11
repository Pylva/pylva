import { createClient } from '@clickhouse/client';
import {
  checkClickHouseReadiness,
  failedClickHouseReadinessChecks,
} from '../src/lib/clickhouse/readiness.js';

async function main(): Promise<void> {
  const url = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
  const client = createClient({ url });

  try {
    const result = await checkClickHouseReadiness(client);
    console.log(`ClickHouse readiness: ${result.ready ? 'ready' : 'not ready'}`);
    for (const check of result.checks) {
      const suffix =
        check.missing && check.missing.length > 0
          ? ` (missing: ${check.missing.join(', ')})`
          : check.message
            ? ` (${check.message})`
            : '';
      console.log(`[${check.ok ? 'ok' : 'fail'}] ${check.name}${suffix}`);
    }

    const failed = failedClickHouseReadinessChecks(result);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('ClickHouse doctor failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
