// v1.1 — coverage for the tier-walking helper exposed from
// src/lib/ingest/cost-source-pricing.ts and the parallel inline walk
// in src/lib/cost-calculator.ts.

import { describe, expect, it } from 'vitest';
import { priceForUnits } from '../../src/lib/ingest/tier-walk';
import {
  calculateCostUsd,
  emptyPricingMap,
  metricKey,
  type MetricPriceRow,
} from '../../src/lib/cost-calculator';
import { InstrumentationTier, type TelemetryEvent } from '@pylva/shared';

describe('priceForUnits — tier walk', () => {
  const tiers = [
    { from: 0, to: 10_000, price: 0.001 },
    { from: 10_000, to: 100_000, price: 0.0008 },
    { from: 100_000, to: null, price: 0.0005 },
  ];

  it('returns 0 for non-positive units', () => {
    expect(priceForUnits(0, tiers)).toBe(0);
    expect(priceForUnits(-5, tiers)).toBe(0);
    expect(priceForUnits(NaN, tiers)).toBe(0);
  });

  it('prices entirely within the first tier', () => {
    expect(priceForUnits(5_000, tiers)).toBeCloseTo(5_000 * 0.001, 6);
  });

  it('spans first into second tier', () => {
    // 10k @ 0.001 + 2k @ 0.0008
    expect(priceForUnits(12_000, tiers)).toBeCloseTo(10 + 1.6, 6);
  });

  it('spans into the open-ended top tier', () => {
    // 10k @ 0.001 + 90k @ 0.0008 + 50k @ 0.0005 = 10 + 72 + 25 = 107
    expect(priceForUnits(150_000, tiers)).toBeCloseTo(107, 6);
  });

  it('returns null for non-contiguous tiers', () => {
    const broken = [
      { from: 0, to: 100, price: 0.01 },
      { from: 200, to: null, price: 0.005 }, // gap from 100..200
    ];
    expect(priceForUnits(50, broken)).toBeNull();
  });

  it('returns null for empty tier list', () => {
    expect(priceForUnits(100, [])).toBeNull();
  });

  it('returns null when units exceed the last closed tier boundary (silent-truncation guard)', () => {
    // Closed tier table: only covers 0..500. Reporting 1000 units would silently
    // bill for 500 and discard the rest. The fix returns null so the event is
    // routed to needs_input instead of being under-billed.
    const closedTiers = [{ from: 0, to: 500, price: 0.01 }];
    expect(priceForUnits(501, closedTiers)).toBeNull();
    expect(priceForUnits(1000, closedTiers)).toBeNull();
    // Exactly at the boundary is still fully priced (remaining === 0 after loop).
    expect(priceForUnits(500, closedTiers)).toBeCloseTo(500 * 0.01, 6);
  });

  it('returns null when units exceed last closed tier in a multi-tier table', () => {
    const multiClosed = [
      { from: 0, to: 100, price: 0.01 },
      { from: 100, to: 500, price: 0.005 },
    ];
    // 600 units: 100 @ 0.01 + 400 @ 0.005 = 1 + 2 = 3 covered, 100 units remain
    expect(priceForUnits(600, multiClosed)).toBeNull();
    // Exactly 500 is fully covered
    expect(priceForUnits(500, multiClosed)).toBeCloseTo(1 + 400 * 0.005, 6);
  });

  it('treats IEEE-754 accumulated drift as fully priced (epsilon guard)', () => {
    // Summing 5000 × 0.1 via floating-point loop yields 500.0000000000452,
    // not exactly 500. Without an epsilon guard the remaining 4.5e-11 would
    // cause a false needs_input. The fix uses a 1e-9 relative epsilon so
    // genuine drift (<< 1 unit) is absorbed.
    const closedTiers = [{ from: 0, to: 500, price: 0.01 }];
    let accumulated = 0;
    for (let i = 0; i < 5000; i++) accumulated += 0.1;
    // accumulated ≈ 500.0000000000452 — above 500 by ~4.5e-11
    expect(accumulated).toBeGreaterThan(500);
    expect(priceForUnits(accumulated, closedTiers)).not.toBeNull();
    expect(priceForUnits(accumulated, closedTiers)).toBeCloseTo(500 * 0.01, 6);
  });
});

describe('calculateCostUsd — tier-walking metric path', () => {
  function reportedEvent(metricValue: number): TelemetryEvent {
    return {
      timestamp: '2026-04-29T10:00:00Z',
      builder_id: 'b1',
      trace_id: '00000000-0000-0000-0000-000000000001',
      span_id: '00000000-0000-0000-0000-000000000002',
      customer_id: 'c1',
      provider: 'other',
      operation: 'task',
      tokens_in: 0,
      tokens_out: 0,
      latency_ms: 0,
      status: 'ok',
      cost_source: 'configured',
      instrumentation_tier: InstrumentationTier.REPORTED,
      metric: 'pages_processed',
      metric_value: metricValue,
    } as unknown as TelemetryEvent;
  }

  it('walks tiers when MetricPriceRow.tiers is set', () => {
    const map = emptyPricingMap();
    const row: MetricPriceRow = {
      metric: 'pages_processed',
      price_per_unit_usd: 0,
      tiers: [
        { from: 0, to: 100, price: 0.1 },
        { from: 100, to: null, price: 0.05 },
      ],
      effective_from: new Date(0),
      effective_to: null,
      source: 'cost_sources',
    };
    map.metric.set(metricKey('pages_processed'), [row]);

    const r = calculateCostUsd(reportedEvent(150), map);
    // 100 * 0.10 + 50 * 0.05 = 10 + 2.5 = 12.5
    expect(r.pricing_status).toBe('priced');
    expect(r.cost_usd).toBeCloseTo(12.5, 6);
  });

  it('falls back to flat price when tiers absent', () => {
    const map = emptyPricingMap();
    const row: MetricPriceRow = {
      metric: 'pages_processed',
      price_per_unit_usd: 0.07,
      effective_from: new Date(0),
      effective_to: null,
      source: 'cost_sources',
    };
    map.metric.set(metricKey('pages_processed'), [row]);

    const r = calculateCostUsd(reportedEvent(150), map);
    expect(r.cost_usd).toBeCloseTo(150 * 0.07, 6);
  });

  it('returns needs_input on malformed tier table', () => {
    const map = emptyPricingMap();
    const row: MetricPriceRow = {
      metric: 'pages_processed',
      price_per_unit_usd: 0,
      tiers: [
        { from: 0, to: 10, price: 0.01 },
        { from: 50, to: null, price: 0.005 }, // gap
      ],
      effective_from: new Date(0),
      effective_to: null,
      source: 'cost_sources',
    };
    map.metric.set(metricKey('pages_processed'), [row]);

    const r = calculateCostUsd(reportedEvent(20), map);
    expect(r.cost_usd).toBeNull();
    expect(r.pricing_status).toBe('needs_input');
  });
});
