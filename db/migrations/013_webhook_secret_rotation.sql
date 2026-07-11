-- B2a Phase 0a — Migration 013
-- Webhook secret rotation with 24h grace window (D33).
-- On rotate: secret_prior <- old secret; secret <- new;
--            secret_rotated_at <- NOW().
-- verifyWebhook accepts both while NOW() - secret_rotated_at < 24h, then
-- a cron sweeps secret_prior to NULL (B2b owns the sweep, but any call
-- past 24h rejects secret_prior-signed payloads).
--
-- Per internal design notes (migration 013) + §2e (D33).

ALTER TABLE webhook_configs
  ADD COLUMN secret_prior       TEXT,
  ADD COLUMN secret_rotated_at  TIMESTAMPTZ;

-- A helper view for callers that need to know which secrets are still in
-- their 24h grace window (used by the alert delivery verify path).
CREATE VIEW webhook_configs_with_grace AS
SELECT
  wc.*,
  CASE
    WHEN wc.secret_prior IS NULL THEN FALSE
    WHEN wc.secret_rotated_at IS NULL THEN FALSE
    WHEN NOW() - wc.secret_rotated_at < INTERVAL '24 hours' THEN TRUE
    ELSE FALSE
  END AS grace_active
FROM webhook_configs wc;

-- View inherits RLS from the base table.
