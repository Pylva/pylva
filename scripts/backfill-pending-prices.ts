// Hourly cron script: backfill cost_usd for events whose pricing arrived late.
// Usage: pnpm cron:backfill-pending-prices
//        (Vercel cron points at POST /api/cron/pricing-sync; self-hosted ops
//        can drive this loop via systemd-timer / cron / etc.)

import { runBackfill } from '../src/lib/pricing/backfill.js';
import { closeDb } from '../src/lib/db/client.js';
import { closeClickhouse } from '../src/lib/clickhouse/client.js';

async function main(): Promise<void> {
  const result = await runBackfill();
  console.log(JSON.stringify(result));
  await closeDb();
  await closeClickhouse();
}

main().catch((err) => {
  console.error('backfill failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
