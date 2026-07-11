-- B4-0a — Migration 028
-- Adds the rules track tables and columns needed by B4-T1 (advanced rules).
-- rules.type CHECK already accepts model_routing/reliability_failover
-- (migration 001); only validator + shared types widen here.
--
-- Status / source_type / severity columns sized to VARCHAR(40) to absorb
-- future enum widening without a follow-up migration. last_error capped to
-- VARCHAR(2000) so a chatty provider stack-trace can't bloat the rules
-- table (it's read on every SDK fetch into a 5-min cache).

-------------------------------------------------------------------
-- rules — activation + diagnostic columns
-------------------------------------------------------------------
ALTER TABLE rules
  ADD COLUMN activated_at        TIMESTAMPTZ,
  ADD COLUMN last_triggered_at   TIMESTAMPTZ,
  ADD COLUMN last_error          VARCHAR(2000);

-- No backfill required — these are new columns recording future activations
-- and failures. Existing rules retain their (already-active) state via the
-- existing `enabled` boolean + B3-T3 `status` column.

-------------------------------------------------------------------
-- rule_events — per-rule activity log (model routing applied,
-- failover triggered/recovered, budget blocked, etc.)
-------------------------------------------------------------------
CREATE TABLE rule_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  rule_id         UUID REFERENCES rules(id) ON DELETE SET NULL,
  customer_id     VARCHAR(255),
  event_type      VARCHAR(60) NOT NULL,
  severity        VARCHAR(20) NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  provider        VARCHAR(50),
  model_from      VARCHAR(100),
  model_to        VARCHAR(100),
  message         TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Both indexes lead with builder_id so a bare "list events for builder X"
-- query uses one of them as a leftmost-prefix scan; no separate
-- (builder_id, created_at) index needed.
CREATE INDEX idx_rule_events_builder_customer_created ON rule_events(builder_id, customer_id, created_at DESC);
CREATE INDEX idx_rule_events_builder_rule_created ON rule_events(builder_id, rule_id, created_at DESC);

ALTER TABLE rule_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY rule_events_isolation ON rule_events
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- anomaly_events — backend-detected cost anomalies awaiting review
-------------------------------------------------------------------
CREATE TABLE anomaly_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id          UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  -- External SDK-supplied customer_id (matches rules.customer_id + rule_events.customer_id).
  customer_id         VARCHAR(255),
  source_type         VARCHAR(40) NOT NULL
                        CHECK (source_type IN (
                          'cost_spike',
                          'cost_drop',
                          'deploy_drop',
                          'source_silence',
                          'margin_risk'
                        )),
  status              VARCHAR(40) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'dismissed', 'converted_to_rule')),
  severity            VARCHAR(20) NOT NULL DEFAULT 'warn'
                        CHECK (severity IN ('info', 'warn', 'error')),
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  actual_value        NUMERIC,
  baseline_value      NUMERIC,
  delta_pct           NUMERIC,
  diagnosis           JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommendation      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at        TIMESTAMPTZ
);

CREATE INDEX idx_anomaly_events_builder_status_created ON anomaly_events(builder_id, status, created_at DESC);
CREATE INDEX idx_anomaly_events_builder_customer_created ON anomaly_events(builder_id, customer_id, created_at DESC);

ALTER TABLE anomaly_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY anomaly_events_isolation ON anomaly_events
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
