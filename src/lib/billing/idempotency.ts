// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — invoice idempotency (I-T2-1). 24h TTL per D12.
//
// POST /api/v1/billing/invoices requires a client-supplied `Idempotency-Key`.
// The table (migration 021) stores the key + request body hash + the claimed
// invoice id. On repeat with same key + same body → return the existing
// invoice id. On same key + different body → 409. TTL purge runs daily via
// cron (T2-E), so the claimed window is at most 24h.

import { and, eq, isNull } from 'drizzle-orm';
import { withRLS } from '../db/rls.js';
import { invoiceIdempotency } from '../db/schema.js';

export { hashBody } from './hash-body.js';

export type ClaimResult =
  | { status: 'new' }
  | { status: 'replay'; invoiceId: string | null }
  | { status: 'conflict' };

/**
 * Try to claim an idempotency key for this builder + body hash.
 * - new: nothing existed; caller proceeds to create the invoice + commit(key, invoiceId).
 * - replay: same key + same body → return the prior invoice (may be null if
 *   creation failed between claim + commit; safe to retry but caller should
 *   not create a second invoice).
 * - conflict: same key + different body → caller emits 409.
 *
 * Insert-and-return uses onConflictDoNothing to keep the race atomic; if the
 * conflict row already exists we follow up with a SELECT to decide replay vs
 * conflict.
 */
export async function checkOrClaim(params: {
  builderId: string;
  key: string;
  bodyHash: string;
}): Promise<ClaimResult> {
  return withRLS(params.builderId, async (tx) => {
    const inserted = await tx
      .insert(invoiceIdempotency)
      .values({
        idempotency_key: params.key,
        builder_id: params.builderId,
        invoice_id: null,
        request_hash: params.bodyHash,
      })
      .onConflictDoNothing()
      .returning({ key: invoiceIdempotency.idempotency_key });

    if (inserted.length === 1) return { status: 'new' } as const;

    // Row already existed. Load it + decide.
    const existing = await tx
      .select({
        request_hash: invoiceIdempotency.request_hash,
        invoice_id: invoiceIdempotency.invoice_id,
      })
      .from(invoiceIdempotency)
      .where(
        and(
          eq(invoiceIdempotency.idempotency_key, params.key),
          eq(invoiceIdempotency.builder_id, params.builderId),
        ),
      )
      .limit(1);

    const row = existing[0];
    if (!row) return { status: 'new' } as const; // RLS must have matched someone else's key? unlikely
    if (row.request_hash !== params.bodyHash) return { status: 'conflict' } as const;
    return { status: 'replay', invoiceId: row.invoice_id } as const;
  });
}

/**
 * Write the claimed invoice id back to the idempotency row. Called after
 * the invoice row is created + committed.
 */
export async function commitClaim(params: {
  builderId: string;
  key: string;
  invoiceId: string;
}): Promise<void> {
  await withRLS(params.builderId, async (tx) => {
    await tx
      .update(invoiceIdempotency)
      .set({ invoice_id: params.invoiceId })
      .where(
        and(
          eq(invoiceIdempotency.idempotency_key, params.key),
          eq(invoiceIdempotency.builder_id, params.builderId),
        ),
      );
  });
}

/**
 * Remove a matching uncommitted claim after an expected preflight failure.
 *
 * Billing errors such as `stripe_not_connected` happen before a Stripe draft
 * invoice exists. Keeping the claim would poison the key for 24h and block the
 * customer from retrying the same request after fixing onboarding/pricing.
 */
export async function releaseClaim(params: {
  builderId: string;
  key: string;
  bodyHash: string;
}): Promise<void> {
  await withRLS(params.builderId, async (tx) => {
    await tx
      .delete(invoiceIdempotency)
      .where(
        and(
          eq(invoiceIdempotency.idempotency_key, params.key),
          eq(invoiceIdempotency.builder_id, params.builderId),
          eq(invoiceIdempotency.request_hash, params.bodyHash),
          isNull(invoiceIdempotency.invoice_id),
        ),
      );
  });
}
