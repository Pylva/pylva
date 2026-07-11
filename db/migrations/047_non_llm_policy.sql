-- Non-LLM runtime policy for SDK tool-call tracking.
--
-- Adds the dashboard-controlled state that lets builders decide whether a
-- discovered non-LLM tool should be tracked as cost, ignored, or kept pending.

ALTER TABLE cost_sources
  ADD COLUMN tracking_status VARCHAR(20) NOT NULL DEFAULT 'tracked'
    CHECK (tracking_status IN ('tracked', 'ignored', 'pending')),
  ADD COLUMN matchers TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN default_metric_value DOUBLE PRECISION,
  ADD COLUMN last_discovered_at TIMESTAMPTZ,
  ADD COLUMN discovery_count INTEGER NOT NULL DEFAULT 0;

UPDATE cost_sources
SET matchers = ARRAY[slug]
WHERE matchers = '{}';

CREATE INDEX idx_cost_sources_builder_tracking_status
  ON cost_sources(builder_id, tracking_status);

