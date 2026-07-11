// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — CLI wrapper for the idempotency purge.

import { purgeInvoiceIdempotency } from '../src/lib/billing/purge-invoice-idempotency.js';

async function main(): Promise<void> {
  const result = await purgeInvoiceIdempotency({ now: new Date() });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
