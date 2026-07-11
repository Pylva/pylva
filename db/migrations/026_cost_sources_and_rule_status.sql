-- B3 Phase 0c — Migration 026
-- Adds cost_sources (non-LLM + auto-registered LLM tracking) and the rules.status
-- column used by the T3 simulator to persist draft recommendations without
-- coupling to the future B4 rules engine.
--
-- Per internal design notes (D17, D28, D34)
--
-- Notes (memory: feedback_migration_gotchas.md):
--   - Backfills here are unconditional (no WHERE col = NOW() trap).
--   - rules.status is a new column with only 'active'/'draft' — fits default
--     VARCHAR(20); no widening needed.

-------------------------------------------------------------------
-- cost_sources: builder-declared cost sources (LLM + non-LLM)
-------------------------------------------------------------------
CREATE TABLE cost_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  source_type     VARCHAR(30) NOT NULL
                    CHECK (source_type IN ('llm_provider', 'non_llm_manual')),
  display_name    VARCHAR(200) NOT NULL,
  slug            VARCHAR(100) NOT NULL,
  metric          VARCHAR(100),
  unit            VARCHAR(50),
  price_per_unit  DECIMAL(12,6),
  pricing_tiers   JSONB,
  status          VARCHAR(20) NOT NULL DEFAULT 'healthy'
                    CHECK (status IN ('healthy', 'warning', 'broken')),
  last_seen_at    TIMESTAMPTZ,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (builder_id, slug)
);

CREATE INDEX idx_cost_sources_builder ON cost_sources(builder_id);
CREATE INDEX idx_cost_sources_builder_status ON cost_sources(builder_id, status);

ALTER TABLE cost_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY cost_sources_isolation ON cost_sources
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- rules.status: draft vs active (D17 — simulator recommendations)
-------------------------------------------------------------------
-- New column, short literal values. VARCHAR(20) is sufficient; no widen needed.
ALTER TABLE rules
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'draft'));

-- No backfill required — the DEFAULT populates every existing row with 'active',
-- which is the correct prior behaviour (all rules were evaluable).

CREATE INDEX idx_rules_builder_status ON rules(builder_id, status);
