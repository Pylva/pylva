-- Track 3 PR 3.1 — rules + portal contract additions.
-- Per internal design notes
-- (O16 + O29 + O35).
--
-- Note: Rev 2 plan calls this "028_b4_rules_portal.sql" but migrations
-- 028 (b4_rules), 029 (b4_portal), and 030 (anomaly_idempotency) already
-- shipped under different scopes during the B4-T1 work. This migration
-- adds the missing pieces on top of that history.
--
-- Idempotent everywhere — re-runs are no-ops.

-- ---------------------------------------------------------------------------
-- O16 — builders.tier default → 'pro' for new rows.
-- Existing rows keep whatever tier they're on. Stripe-driven tier sync is
-- a follow-up; this just stops new sign-ups from defaulting to 'free' and
-- failing every advanced-rules / portal feature gate out of the box.
-- ---------------------------------------------------------------------------
ALTER TABLE builders ALTER COLUMN tier SET DEFAULT 'pro';

-- ---------------------------------------------------------------------------
-- O29 — feature_flag_overrides: per-builder beta rollout on top of env
-- defaults. Resolution: env default OR builder override (override wins).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  flag_name   TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (builder_id, flag_name)
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_overrides_flag
  ON feature_flag_overrides(flag_name);

ALTER TABLE feature_flag_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feature_flag_overrides_isolation ON feature_flag_overrides;
CREATE POLICY feature_flag_overrides_isolation ON feature_flag_overrides
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-- ---------------------------------------------------------------------------
-- O35 — audit_log already exists (B2a migration 001 + 019). It already has
-- RLS, partitioning by month, builder_id index, and actor_user_id. This
-- migration extends partition coverage forward and registers the 1-year
-- retention purge cron (purge-audit-log added in this PR).
--
-- Add monthly partitions for the next 12 months so the partition manager
-- has runway. The partition-manager cron (existing infra) will append more.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  m_start DATE := date_trunc('month', NOW())::DATE;
  m_end   DATE;
  pname   TEXT;
  i INT;
BEGIN
  FOR i IN 0..12 LOOP
    m_start := (date_trunc('month', NOW()) + (i || ' months')::interval)::DATE;
    m_end   := (m_start + INTERVAL '1 month')::DATE;
    pname   := 'audit_log_y' || to_char(m_start, 'YYYY') || 'm' || to_char(m_start, 'MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      pname, m_start, m_end
    );
  END LOOP;
END$$;
