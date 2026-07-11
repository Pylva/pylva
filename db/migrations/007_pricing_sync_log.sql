-- Pylva Pricing Sync Log (B1 — Decision D30)
-- Records each LiteLLM sync attempt. Global table (admin data, no RLS).
-- Used to detect 3-consecutive-failure state for snapshot fallback.

CREATE TABLE pricing_sync_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status           TEXT NOT NULL
                     CHECK (status IN ('success', 'aborted', 'partial')),
  failure_reason   TEXT,
  models_synced    INTEGER NOT NULL DEFAULT 0,
  models_skipped   INTEGER NOT NULL DEFAULT 0,
  attempt_number   INTEGER NOT NULL DEFAULT 1,
  source           TEXT NOT NULL DEFAULT 'litellm'
                     CHECK (source IN ('litellm', 'snapshot', 'admin_override'))
);

CREATE INDEX idx_pricing_sync_log_run_at ON pricing_sync_log(run_at DESC);
CREATE INDEX idx_pricing_sync_log_status ON pricing_sync_log(status, run_at DESC);
