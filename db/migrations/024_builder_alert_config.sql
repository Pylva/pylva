-- B2b Phase 0b — Migration 024
-- Builder-level alert channel (distinct from per-rule channels). Used by the
-- Stripe webhook consumer to fire payment_failed + dispute notifications to
-- the builder's chosen channel. Kept separate from rule_alert_channels so
-- disabling one doesn't affect the other (D19).
--
-- Same exactly-one-of shape as rule_alert_channels (migration 017) so the
-- channel-delivery code reuses B2a's channels/{webhook,email,slack}.ts path.
--
-- Per internal design notes (migration 024) + §5.1 +
-- §5.2 I-T2-6 + D19.

CREATE TABLE builder_alert_config (
  builder_id         UUID PRIMARY KEY REFERENCES builders(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL CHECK (channel IN ('webhook', 'email', 'slack')),
  enabled            BOOLEAN NOT NULL DEFAULT true,
  webhook_config_id  UUID REFERENCES webhook_configs(id) ON DELETE SET NULL,
  email_recipients   TEXT[],
  slack_webhook_url  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bac_exactly_one_of CHECK (
    (channel = 'webhook'
       AND webhook_config_id IS NOT NULL
       AND email_recipients IS NULL
       AND slack_webhook_url IS NULL)
    OR
    (channel = 'email'
       AND webhook_config_id IS NULL
       AND email_recipients IS NOT NULL
       AND array_length(email_recipients, 1) BETWEEN 1 AND 10
       AND slack_webhook_url IS NULL)
    OR
    (channel = 'slack'
       AND webhook_config_id IS NULL
       AND email_recipients IS NULL
       AND slack_webhook_url IS NOT NULL)
  )
);

CREATE INDEX idx_builder_alert_config_webhook ON builder_alert_config(webhook_config_id)
  WHERE webhook_config_id IS NOT NULL;

ALTER TABLE builder_alert_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY builder_alert_config_isolation ON builder_alert_config
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
