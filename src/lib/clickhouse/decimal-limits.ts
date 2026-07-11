// Storage limits for the ClickHouse cost_events Decimal columns.
// Dependency-free so both the pure cost-calculator and semantic-validation
// can import it without bootstrapping the ClickHouse client / config.

/**
 * Largest value the `cost_events.cost_usd` and `cost_events.abort_savings`
 * columns can hold: ClickHouse `Decimal(10,6)` → precision 10, scale 6 →
 * max 9999.999999 (db/clickhouse/001_cost_events.sql + migration 002).
 *
 * A value above this CANNOT be stored: ClickHouse rejects the row on INSERT
 * (decimal overflow), which fails the *whole* batch insert and returns a 500 —
 * losing every event in the batch, not just the oversized one. Ingest must
 * keep computed costs and SDK-supplied savings at or below this bound.
 */
export const MAX_STORABLE_COST_USD = 9999.999999;

/**
 * Largest value the UInt32 token columns can hold (`tokens_in`/`tokens_out`).
 * Shared by ingest semantic validation and the public OpenAPI document.
 */
export const UINT32_MAX = 4_294_967_295;

export function roundCostUsd6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function isStorableCostUsd(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_STORABLE_COST_USD;
}

export function normalizeComputedCostUsd(value: number): number | null {
  if (!isStorableCostUsd(value)) return null;
  const rounded = roundCostUsd6(value);
  return isStorableCostUsd(rounded) ? rounded : null;
}
