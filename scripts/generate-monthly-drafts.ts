// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — CLI wrapper for generateMonthlyDrafts.
//
// Usage: pnpm tsx scripts/generate-monthly-drafts.ts
//
// Dev shortcut for running the monthly-draft cron logic without going
// through EventBridge. The actual logic lives in src/lib/billing/
// monthly-drafts.ts so both the cron route and this CLI share one
// implementation.

import { generateMonthlyDrafts } from '../src/lib/billing/monthly-drafts.js';

async function main(): Promise<void> {
  const result = await generateMonthlyDrafts({ now: new Date() });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
