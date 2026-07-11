// Server-side cost calculation.
// NEVER accept cost_usd from the SDK. Always resolve pricing at event.timestamp
// from the pricingMap pre-fetched by pricing-lookup.ts.
//
// Returns cost_usd = null when no pricing row covers the event — the caller
// sets pricing_status='needs_input' and opens a pricing_onboarding_tasks row.
// Rounded to 6 decimal places to match ClickHouse Decimal(10,6) precision.

import { InstrumentationTier, type TelemetryEvent } from '@pylva/shared';
import { normalizeComputedCostUsd } from './clickhouse/decimal-limits.js';

export interface LlmPriceRow {
  provider: string;
  model: string;
  input_per_1m_usd: number;
  output_per_1m_usd: number;
  effective_from: Date;
  effective_to: Date | null;
  source: 'llm_pricing' | 'custom_pricing';
}

export interface MetricPriceRow {
  metric: string;
  price_per_unit_usd: number;
  /**
   * v1.1 follow-up: optional tier table for cost_sources rows. When
   * present, the calculator walks tiers via priceForUnits instead of
   * applying the flat price_per_unit_usd. custom_pricing rows never
   * carry tiers — they remain flat.
   */
  tiers?: Array<{ from: number; to: number | null; price: number }>;
  effective_from: Date;
  effective_to: Date | null;
  // Track 2 PR 2.4: cost_sources fallback joins this map alongside the
  // existing custom_pricing rows. pickActive prefers earlier-matching
  // rows so custom_pricing still wins when both are present.
  source: 'custom_pricing' | 'cost_sources';
}

export interface PricingMap {
  // key: `llm:${provider}:${model}`
  llm: Map<string, LlmPriceRow[]>;
  // key: `metric:${metric}`
  metric: Map<string, MetricPriceRow[]>;
}

export function emptyPricingMap(): PricingMap {
  return { llm: new Map(), metric: new Map() };
}

export function llmKey(provider: string, model: string): string {
  return `llm:${provider}:${model}`;
}

export function metricKey(metric: string): string {
  return `metric:${metric}`;
}

// PR #73 follow-up — tier-walk math lives in src/lib/ingest/tier-walk.ts
// as a pure helper with 9 unit tests. The earlier private walkTiers
// was near-identical except for empty-tiers handling: the helper now
// returns null (routes to needs_pricing) where the old fall-through
// returned 0. The current call site at line 105 guards on
// `tiers.length > 0` before invoking, so the divergence is masked
// today. The guard is load-bearing — do not remove without first
// auditing the empty-tiers semantics expected by REPORTED-tier
// pricing rows. Re-export priceForUnits so the rest of this file
// reads naturally.
import { priceForUnits as walkTiers } from './ingest/tier-walk.js';

/**
 * Pick the pricing row whose [effective_from, effective_to) interval covers
 * the event timestamp. If multiple rows match (e.g. custom + llm), the caller
 * is expected to have already filtered: custom_pricing rows override llm_pricing.
 */
function pickActive<T extends { effective_from: Date; effective_to: Date | null }>(
  rows: T[] | undefined,
  eventTimestamp: Date,
): T | undefined {
  if (!rows) return undefined;
  return rows.find((row) => {
    if (row.effective_from > eventTimestamp) return false;
    if (row.effective_to && row.effective_to <= eventTimestamp) return false;
    return true;
  });
}

// A computed cost outside the storable non-negative Decimal(10,6) range cannot
// be persisted (it would overflow the cost_usd column and fail the whole batch
// insert). The reported tier is the realistic trigger: metric_value is capped at
// 1e9, so any per-unit price above ~1e-5 USD can push a single event past the bound.
// Rather than poison-pill the batch (or silently store a wrapped value), treat
// an unstorable cost as unpriced → needs_input. The event still persists
// (cost_usd = null) and surfaces a NEEDS_PRICING_INPUT warning + onboarding
// task, so the builder is told their pricing produced an out-of-range cost.
function finalize(cost: number): CostResult {
  const normalized = normalizeComputedCostUsd(cost);
  if (normalized === null) {
    return { cost_usd: null, pricing_status: 'needs_input' };
  }
  return { cost_usd: normalized, pricing_status: 'priced' };
}

export type CostResult =
  | { cost_usd: number; pricing_status: 'priced' }
  | { cost_usd: null; pricing_status: 'needs_input' };

/**
 * Calculate USD cost for a telemetry event.
 * - LLM (sdk_wrapper tier): (tokens_in * input_per_1m + tokens_out * output_per_1m) / 1_000_000
 * - Non-LLM (reported tier): metric_value * price_per_unit_usd
 * - Unpriced → { cost_usd: null, pricing_status: 'needs_input' }
 */
export function calculateCostUsd(event: TelemetryEvent, pricingMap: PricingMap): CostResult {
  const ts = new Date(event.timestamp);

  if (event.instrumentation_tier === InstrumentationTier.REPORTED) {
    if (event.metric == null || event.metric_value == null) {
      return { cost_usd: null, pricing_status: 'needs_input' };
    }
    const row = pickActive(pricingMap.metric.get(metricKey(event.metric)), ts);
    if (!row) return { cost_usd: null, pricing_status: 'needs_input' };
    if (row.tiers && row.tiers.length > 0) {
      const total = walkTiers(event.metric_value, row.tiers);
      if (total === null) return { cost_usd: null, pricing_status: 'needs_input' };
      return finalize(total);
    }
    return finalize(event.metric_value * row.price_per_unit_usd);
  }

  // sdk_wrapper (LLM) tier
  if (event.provider == null || event.model == null) {
    return { cost_usd: null, pricing_status: 'needs_input' };
  }
  const row = pickActive(pricingMap.llm.get(llmKey(event.provider, event.model)), ts);
  if (!row) return { cost_usd: null, pricing_status: 'needs_input' };

  const cost =
    (event.tokens_in * row.input_per_1m_usd + event.tokens_out * row.output_per_1m_usd) / 1_000_000;
  return finalize(cost);
}
