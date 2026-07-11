// SPDX-License-Identifier: Elastic-2.0
// B2b T2-C — detect pricing-version boundaries inside a billing period.
//
// I-T2-10 auto-split: if a builder changes pricing mid-period, the invoice
// generator emits N drafts — one per slice of the period covered by a
// distinct pricing version. They share a `billing_cycle_id` UUID so the
// dashboard can group them under a single "Billing cycle APRIL 2026" view.
//
// Input: versions ordered by effective_from ASC that overlap the period.
// Output: one SplitSlice per version, each clamped to the period bounds.
// When `versions.length === 1` → single slice == full period (no split).
// When length === 0 → empty array (caller treats as 400 pricing_not_configured).

import { createHash } from 'node:crypto';
import type { VersionedPricingRow } from './pricing-versioning.js';

const UUID_URL_NAMESPACE_BYTES = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
const BILLING_CYCLE_UUID_NAME_PREFIX = 'pylva:billing-cycle:';

/**
 * Deterministically derive a `billing_cycle_id` as a standard RFC-4122 UUIDv5
 * from a stable seed -- the dedupe namespace of an auto-split run (builder +
 * draft-key base).
 *
 * Why this exists: the monthly-drafts cron is built to tolerate concurrent
 * pods / same-window re-runs by inserting each slice with `ON CONFLICT DO
 * NOTHING` on the `(builder_id, draft_key)` partial unique index. If the cycle
 * id were `randomUUID()` per invocation, two invocations that each win the
 * INSERT for a *different* slice of the same split cycle would stamp the slices
 * with *different* cycle ids — fracturing one billing cycle into two and
 * breaking the I-T2-10 invariant ("all drafts in an auto-split share one
 * billing_cycle_id") plus the `GET /invoices?billing_cycle_id=` grouping.
 *
 * Seeding the id off the deterministic dedupe key makes every concurrent
 * invocation compute the *same* cycle id, so the slices always agree.
 *
 * Scheme: UUIDv5 with the URL namespace
 * (`6ba7b811-9dad-11d1-80b4-00c04fd430c8`) and name
 * `pylva:billing-cycle:${seed}`. External repair or audit tools can
 * reproduce ids with standard UUIDv5 implementations.
 */
export function billingCycleIdFor(seed: string): string {
  const bytes = createHash('sha1')
    .update(UUID_URL_NAMESPACE_BYTES)
    .update(`${BILLING_CYCLE_UUID_NAME_PREFIX}${seed}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // RFC-4122 UUIDv5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant 10xx
  const hex = Buffer.from(bytes).toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

export interface SplitSlice {
  version: VersionedPricingRow;
  slice_start: Date;
  slice_end: Date;
}

export interface SplitPlan {
  slices: SplitSlice[];
  /** true iff any boundary lies strictly inside the period (i.e. N > 1 slices). */
  split: boolean;
}

export function detectBoundary(
  versions: VersionedPricingRow[],
  period: { start: Date; end: Date },
): SplitPlan {
  if (versions.length === 0) return { slices: [], split: false };

  const slices: SplitSlice[] = [];
  for (const v of versions) {
    const vStart = new Date(v.effective_from);
    const vEnd = v.effective_to ? new Date(v.effective_to) : period.end;

    const sliceStart = vStart.getTime() > period.start.getTime() ? vStart : period.start;
    const sliceEnd = vEnd.getTime() < period.end.getTime() ? vEnd : period.end;

    // Skip zero-duration (or negative — defensive) slices. They can occur
    // when the period boundary exactly aligns with a version change.
    if (sliceEnd.getTime() <= sliceStart.getTime()) continue;

    slices.push({ version: v, slice_start: sliceStart, slice_end: sliceEnd });
  }

  return { slices, split: slices.length > 1 };
}
