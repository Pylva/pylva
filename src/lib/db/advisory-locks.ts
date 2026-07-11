// PostgreSQL advisory locks that must be importable from the Lambda ingest path.
// Keep this module Next-free: never import next/* here.

import { sql as drizzleSql } from 'drizzle-orm';
import { isBuilderTier, type BuilderTier } from '@pylva/shared';
import type { DrizzleTransaction } from './rls.js';
import { unwrapRows } from './query-utils.js';

export function customerLimitLockKey(builderId: string): string {
  return `customer_limit:${builderId}`;
}

export async function lockCustomerLimit(tx: DrizzleTransaction, builderId: string): Promise<void> {
  await tx.execute(drizzleSql`
    SELECT pg_advisory_xact_lock(hashtextextended(${customerLimitLockKey(builderId)}, 0))
  `);
}

/**
 * Re-read the authoritative builder tier inside a customer-limit transaction.
 * Callers MUST hold lockCustomerLimit first: advisory lock -> builders row lock
 * is the single global order that keeps customer-limit writers and tier writers
 * serialized without deadlocks.
 */
export async function getBuilderTierForShare(
  tx: DrizzleTransaction,
  builderId: string,
): Promise<BuilderTier | null> {
  const result = await tx.execute(drizzleSql`
    SELECT tier
    FROM builders
    WHERE id = ${builderId}
    FOR SHARE
  `);
  const row = unwrapRows<{ tier: unknown }>(result)[0];
  return isBuilderTier(row?.tier) ? row.tier : null;
}
