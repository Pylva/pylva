// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — shared impl for the idempotency-purge cron.
//
// Deletes rows from invoice_idempotency older than 24h (D12 TTL). Runs
// daily at 00:15 UTC. Operates outside RLS because the table is keyed by
// idempotency_key (not per-builder) and we purge across all builders in
// one query.

import { lt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { invoiceIdempotency } from '../db/schema.js';

export interface PurgeInvoiceIdempotencyResult {
  deleted: number;
  cutoff: string;
}

export async function purgeInvoiceIdempotency(opts: {
  now: Date;
}): Promise<PurgeInvoiceIdempotencyResult> {
  const cutoff = new Date(opts.now.getTime() - 24 * 3_600_000);
  const result = await db
    .delete(invoiceIdempotency)
    .where(lt(invoiceIdempotency.created_at, cutoff))
    .returning({ key: invoiceIdempotency.idempotency_key });
  return { deleted: result.length, cutoff: cutoff.toISOString() };
}
