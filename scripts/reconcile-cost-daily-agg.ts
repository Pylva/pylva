// Daily cron script: check cost_daily_agg_v2 MV drift vs cost_events.
// Usage: pnpm cron:reconcile-cost-daily-agg [YYYY-MM-DD]

import { runReconcile } from '../src/lib/pricing/reconcile.js';
import { closeDb } from '../src/lib/db/client.js';
import { closeClickhouse } from '../src/lib/clickhouse/client.js';

async function main(): Promise<void> {
  const day = process.argv[2];
  const result = await runReconcile(day);
  console.log(JSON.stringify(result));
  await closeDb();
  await closeClickhouse();
  if (result.alert_fired) process.exit(2);
}

main().catch((err) => {
  console.error('reconcile failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
