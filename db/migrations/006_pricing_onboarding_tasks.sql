-- Pylva Pricing Onboarding Tasks (B1 — Decision D35)
-- Tracks unseen (provider, model) or (metric) pairs that ingested without priced lookup.
-- Closed when custom_pricing or llm_pricing lands + backfill job completes.
-- RLS by builder_id.

CREATE TABLE pricing_onboarding_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id     UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  provider       VARCHAR(100),
  model          VARCHAR(100),
  metric         VARCHAR(200),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'resolved')),
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ,
  resolved_by    UUID,                         -- API key id or user id; nullable for system resolutions

  -- Mirrors custom_pricing: either (provider, model) or (metric) is set, not both.
  CHECK (
    (provider IS NOT NULL AND model IS NOT NULL AND metric IS NULL)
    OR
    (provider IS NULL AND model IS NULL AND metric IS NOT NULL)
  )
);

-- One open task per (builder, provider, model) or (builder, metric).
CREATE UNIQUE INDEX idx_onboarding_llm_unique
  ON pricing_onboarding_tasks(builder_id, provider, model)
  WHERE provider IS NOT NULL;

CREATE UNIQUE INDEX idx_onboarding_metric_unique
  ON pricing_onboarding_tasks(builder_id, metric)
  WHERE metric IS NOT NULL;

CREATE INDEX idx_onboarding_builder_status
  ON pricing_onboarding_tasks(builder_id, status);

ALTER TABLE pricing_onboarding_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_onboarding_tasks_isolation ON pricing_onboarding_tasks
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
