-- Pylva Custom Pricing (B1 — spec Section 4.11, Decision D31)
-- Builder-scoped pricing table for fine-tuned models, non-LLM metrics, and admin overrides.
-- Lookup order at ingest: custom_pricing (builder-scoped) → llm_pricing (global) → mark pending.
--
-- Provenance: `source` + `created_by` columns + audit_log row on every mutation.
-- RLS by builder_id (same pattern as rules / customers / webhook_configs).

CREATE TABLE custom_pricing (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id           UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  provider             VARCHAR(100),               -- NULL for non-LLM metric rows
  model                VARCHAR(100),               -- NULL for non-LLM metric rows
  metric               VARCHAR(200),               -- NON-NULL for non-LLM; NULL for LLM
  price_per_unit_usd   NUMERIC(18,10) NOT NULL,    -- normalized: per-token for LLM, per-unit for non-LLM
  input_per_1m_usd     NUMERIC(18,10),             -- optional: per-1M-input-tokens (LLM only)
  output_per_1m_usd    NUMERIC(18,10),             -- optional: per-1M-output-tokens (LLM only)
  effective_from       TIMESTAMPTZ NOT NULL,
  effective_to         TIMESTAMPTZ,
  source               TEXT NOT NULL
                         CHECK (source IN ('builder_manual', 'litellm_sync', 'admin_override')),
  created_by           UUID,                       -- NULL for system-sourced; references users(id) when user table lands
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Exactly one of (provider+model) OR (metric) must be set. Enforced so ingest lookup is unambiguous.
  CHECK (
    (provider IS NOT NULL AND model IS NOT NULL AND metric IS NULL)
    OR
    (provider IS NULL AND model IS NULL AND metric IS NOT NULL)
  )
);

CREATE INDEX idx_custom_pricing_llm_lookup
  ON custom_pricing(builder_id, provider, model, effective_from)
  WHERE provider IS NOT NULL;

CREATE INDEX idx_custom_pricing_metric_lookup
  ON custom_pricing(builder_id, metric, effective_from)
  WHERE metric IS NOT NULL;

-- One active pricing row per (builder, provider, model, effective_from) and (builder, metric, effective_from)
CREATE UNIQUE INDEX idx_custom_pricing_llm_unique
  ON custom_pricing(builder_id, provider, model, effective_from)
  WHERE provider IS NOT NULL;

CREATE UNIQUE INDEX idx_custom_pricing_metric_unique
  ON custom_pricing(builder_id, metric, effective_from)
  WHERE metric IS NOT NULL;

ALTER TABLE custom_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY custom_pricing_isolation ON custom_pricing
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
