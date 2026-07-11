// Pure tier-walking math. No DB / config / runtime deps so tests can
// import it without env bootstrap.
//
// Volume-graduated model: every unit is priced at the tier it lands in.
// Tiers must be contiguous — first tier starts at 0, each next tier's
// `from` equals the previous tier's `to`. The final tier should have
// to=null (open-ended); a closed final tier causes null for any units
// that exceed its upper bound.

export interface PricingTierLite {
  from: number;
  to: number | null;
  price: number;
}

/**
 * Returns the total cost for `units` priced through `tiers`. Returns 0
 * for non-positive units. Returns null when the tier table is malformed
 * (gaps / overlaps / empty) or when `units` exceed the last closed tier's
 * upper boundary — both cases route the caller to needs_input rather than
 * silently under-billing.
 */
export function priceForUnits(units: number, tiers: PricingTierLite[]): number | null {
  if (!Number.isFinite(units) || units <= 0) return 0;
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.from - b.from);

  let prevTo: number | null = 0;
  for (const t of sorted) {
    if (prevTo === null) return null;
    if (t.from !== prevTo) return null;
    prevTo = t.to;
  }

  let remaining = units;
  let total = 0;
  for (const t of sorted) {
    if (remaining <= 0) break;
    const span = t.to === null ? remaining : t.to - t.from;
    const consumed = Math.min(remaining, span);
    total += consumed * t.price;
    remaining -= consumed;
  }
  // Relative epsilon absorbs IEEE-754 drift (e.g. 5000 × 0.1 → 500 + 4.5e-11);
  // genuine overflows are ≥ 1 unit above boundary, orders of magnitude larger.
  if (remaining > units * 1e-9) return null;
  return total;
}
