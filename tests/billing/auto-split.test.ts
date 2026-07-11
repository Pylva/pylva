// B2b T2-C — detectBoundary() unit tests (I-T2-10 boundary math).
//
// Validates slice generation against every edge the plan calls out: single
// version, mid-period boundary, pre-period start, post-period end, zero-
// duration slice elision, empty version list.

import { describe, it, expect } from 'vitest';
import { detectBoundary } from '../../src/lib/billing/auto-split.js';
import type { VersionedPricingRow } from '../../src/lib/billing/pricing-versioning.js';

function mkVersion(
  n: number,
  effective_from: string,
  effective_to: string | null,
): VersionedPricingRow {
  return {
    id: `v-${n}`,
    builder_id: 'b1',
    customer_id: 'c1',
    pricing_model: 'flat',
    version: n,
    effective_from: new Date(effective_from),
    effective_to: effective_to ? new Date(effective_to) : null,
    flat_rate_usd: '1.00',
    per_unit_rates: null,
    pack_price_usd: null,
    included_credits: null,
    overage_rate_usd: null,
    markup_pct: null,
    base_fee_usd: null,
    billing_period: 'monthly',
    stripe_customer_id: null,
  };
}

const APRIL = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-05-01T00:00:00Z'),
};

describe('detectBoundary() — auto-split planning', () => {
  it('empty versions → no slices, no split', () => {
    const p = detectBoundary([], APRIL);
    expect(p.slices).toHaveLength(0);
    expect(p.split).toBe(false);
  });

  it('single open-ended version covering the whole period → 1 slice, no split', () => {
    const p = detectBoundary([mkVersion(1, '2026-03-15T00:00:00Z', null)], APRIL);
    expect(p.slices).toHaveLength(1);
    expect(p.split).toBe(false);
    expect(p.slices[0]?.slice_start.toISOString()).toBe(APRIL.start.toISOString());
    expect(p.slices[0]?.slice_end.toISOString()).toBe(APRIL.end.toISOString());
  });

  it('mid-period boundary → 2 slices sharing no overlap, splits at boundary', () => {
    const v1 = mkVersion(1, '2026-03-15T00:00:00Z', '2026-04-15T00:00:00Z');
    const v2 = mkVersion(2, '2026-04-15T00:00:00Z', null);
    const p = detectBoundary([v1, v2], APRIL);
    expect(p.slices).toHaveLength(2);
    expect(p.split).toBe(true);
    expect(p.slices[0]?.slice_start.toISOString()).toBe(APRIL.start.toISOString());
    expect(p.slices[0]?.slice_end.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(p.slices[1]?.slice_start.toISOString()).toBe('2026-04-15T00:00:00.000Z');
    expect(p.slices[1]?.slice_end.toISOString()).toBe(APRIL.end.toISOString());
  });

  it('version starts mid-period and no prior → slice clamped to version effective_from', () => {
    const v1 = mkVersion(1, '2026-04-10T00:00:00Z', null);
    const p = detectBoundary([v1], APRIL);
    expect(p.slices).toHaveLength(1);
    expect(p.slices[0]?.slice_start.toISOString()).toBe('2026-04-10T00:00:00.000Z');
    expect(p.slices[0]?.slice_end.toISOString()).toBe(APRIL.end.toISOString());
  });

  it('version ends mid-period → slice clamped to version effective_to', () => {
    const v1 = mkVersion(1, '2026-03-15T00:00:00Z', '2026-04-20T00:00:00Z');
    const p = detectBoundary([v1], APRIL);
    expect(p.slices).toHaveLength(1);
    expect(p.slices[0]?.slice_start.toISOString()).toBe(APRIL.start.toISOString());
    expect(p.slices[0]?.slice_end.toISOString()).toBe('2026-04-20T00:00:00.000Z');
  });

  it('version ending exactly at period start is elided (zero-duration slice)', () => {
    const v1 = mkVersion(1, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
    const v2 = mkVersion(2, '2026-04-01T00:00:00Z', null);
    const p = detectBoundary([v1, v2], APRIL);
    expect(p.slices).toHaveLength(1);
    expect(p.slices[0]?.version.version).toBe(2);
    expect(p.split).toBe(false);
  });

  it('three versions straddling the period → 3 slices', () => {
    const v1 = mkVersion(1, '2026-03-15T00:00:00Z', '2026-04-10T00:00:00Z');
    const v2 = mkVersion(2, '2026-04-10T00:00:00Z', '2026-04-20T00:00:00Z');
    const v3 = mkVersion(3, '2026-04-20T00:00:00Z', null);
    const p = detectBoundary([v1, v2, v3], APRIL);
    expect(p.slices).toHaveLength(3);
    expect(p.split).toBe(true);
    // slices sum to full period
    const total = p.slices.reduce(
      (acc, s) => acc + (s.slice_end.getTime() - s.slice_start.getTime()),
      0,
    );
    expect(total).toBe(APRIL.end.getTime() - APRIL.start.getTime());
  });
});
