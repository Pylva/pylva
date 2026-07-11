-- B2a Phase 0a — Migration 018
-- Lightweight per-builder feature flags stored as JSONB. We deliberately
-- avoided an external dep (D9) — needs are small and we want zero
-- network hop on the read path. Helper `isEnabled(builderId, flagName)`
-- reads this table + caches with `unstable_cache({revalidate: 60})`.
--
-- Shape: flags = { 'dashboard.beta_trace_tree': true, 'rule.margin_preview': true, ... }
-- A missing key means "default" (usually false). Defaults are centralized
-- in src/lib/feature-flags.ts.
--
-- Per internal design notes (migration 018) + §2b (D9).

CREATE TABLE builder_feature_flags (
  builder_id  UUID PRIMARY KEY REFERENCES builders(id) ON DELETE CASCADE,
  flags       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE builder_feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY builder_feature_flags_isolation ON builder_feature_flags
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
