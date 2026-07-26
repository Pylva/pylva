// PostgreSQL advisory locks that must be importable from the Lambda ingest path.
// Keep this module Next-free: never import next/* here.

import { sql as drizzleSql } from 'drizzle-orm';
import { resolveBuilderEntitlement, type BuilderEntitlementResolution } from '@pylva/shared';
import type { DrizzleTransaction } from './rls.js';
import { unwrapRows } from './query-utils.js';

export function customerLimitLockKey(builderId: string): string {
  return `customer_limit:${builderId}`;
}

/**
 * Compatibility key shared by hosted Checkout, subscription recovery/sync,
 * and explicit operator entitlement writers. This intentionally remains the
 * raw builder ID: changing or domain-prefixing it would split old and new
 * writers onto different PostgreSQL advisory locks during rollout.
 */
export function builderBillingLifecycleLockKey(builderId: string): string {
  return builderId;
}

export async function lockBuilderBillingLifecycle(
  tx: DrizzleTransaction,
  builderId: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${builderBillingLifecycleLockKey(builderId)}, 0)
    )
  `);
}

export async function lockCustomerLimit(tx: DrizzleTransaction, builderId: string): Promise<void> {
  await tx.execute(drizzleSql`
    SELECT pg_advisory_xact_lock(hashtextextended(${customerLimitLockKey(builderId)}, 0))
  `);
}

/**
 * Re-read and validate the complete entitlement tuple while holding the
 * builder row lock. A missing row is distinct from an invalid tuple; callers
 * must fail closed for either result.
 */
export async function getBuilderEntitlementForShare(
  tx: DrizzleTransaction,
  builderId: string,
): Promise<BuilderEntitlementResolution | null> {
  const result = await tx.execute(drizzleSql`
    SELECT
      tier AS plan,
      access_state,
      entitlement_source
    FROM builders
    WHERE id = ${builderId}
    FOR SHARE
  `);
  const row = unwrapRows<{
    plan: unknown;
    access_state: unknown;
    entitlement_source: unknown;
  }>(result)[0];
  return row === undefined ? null : resolveBuilderEntitlement(row);
}

/**
 * Serialize an authoritative entitlement writer against every reader that
 * holds the builder row FOR SHARE. Callers must keep this transaction open
 * through their final lifecycle re-read and mutation.
 */
export async function lockBuilderEntitlementForUpdate(
  tx: DrizzleTransaction,
  builderId: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    SELECT id
    FROM builders
    WHERE id = ${builderId}
    FOR UPDATE
  `);
}
