// B3-T4 — Non-LLM cost source tracking types
// Per internal design notes (D28, D33, D34).
//
// Schema matches migration 026 plus the non-LLM tracking policy extension.
// cost_sources is the PostgreSQL source of truth for both auto-registered LLM
// providers and dashboard-controlled non-LLM sources.

export const CostSourceType = {
  LLM_PROVIDER: 'llm_provider', // auto-registered from ingest (D29)
  NON_LLM_MANUAL: 'non_llm_manual', // discovered by SDK, controlled in dashboard
} as const;

export type CostSourceType = (typeof CostSourceType)[keyof typeof CostSourceType];

export const CostSourceStatus = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  BROKEN: 'broken',
} as const;

export type CostSourceStatus = (typeof CostSourceStatus)[keyof typeof CostSourceStatus];

export const CostSourceTrackingStatus = {
  TRACKED: 'tracked',
  IGNORED: 'ignored',
  PENDING: 'pending',
} as const;

export type CostSourceTrackingStatus =
  (typeof CostSourceTrackingStatus)[keyof typeof CostSourceTrackingStatus];

// D34: tiered pricing JSONB shape. `to: null` = open-ended top tier.
// Flat pricing uses `price_per_unit` column and leaves `pricing_tiers` NULL.
export interface PricingTier {
  from: number;
  to: number | null;
  price: number;
}

// Row shape for the cost_sources table. Named `CostSourceRow` (not
// `CostSource`) to avoid colliding with the pre-existing telemetry enum
// `CostSource { AUTO, CONFIGURED }` that labels the `cost_source` column on
// events. Both names shipped via the barrel export, which broke `tsc` on the
// shared package (TS2308). Kept as an alias below for spec §4.2 readability.
export interface CostSourceRow {
  id: string;
  builder_id: string;
  source_type: CostSourceType;
  display_name: string; // user-typed casing preserved (D28)
  slug: string; // auto-generated, lowercase-hyphenated; UNIQUE (builder_id, slug)
  metric: string | null; // free-text, slugified (D33) — e.g. "characters", "requests"
  unit: string | null;
  price_per_unit: number | null; // flat rate; null when pricing_tiers is set
  pricing_tiers: PricingTier[] | null;
  status: CostSourceStatus;
  tracking_status: CostSourceTrackingStatus;
  matchers: string[];
  default_metric_value: number | null;
  last_seen_at: Date | null;
  last_discovered_at: Date | null;
  discovery_count: number;
  approved_at: Date | null;
  created_at: Date;
}

export interface NonLlmPolicySource {
  slug: string;
  display_name: string;
  status: typeof CostSourceTrackingStatus.TRACKED | typeof CostSourceTrackingStatus.IGNORED;
  matchers: string[];
  metric: string | null;
  unit: string | null;
  default_metric_value: number | null;
}

export interface NonLlmPolicyResponse {
  version: string;
  refresh_after_ms: number;
  unknown_behavior: 'discover_only' | 'ignore';
  sources: NonLlmPolicySource[];
}

export interface NonLlmDiscovery {
  tool_name: string;
  matcher: string;
  step_name?: string | null;
  framework?: string | null;
  status?: string | null;
  timestamp?: string;
  count?: number;
}
