-- B2a Phase 0a — Migration 017
-- Per-rule alert channel config. A rule can fire through multiple
-- channels; a single row here represents one (rule, channel) pairing.
-- Exactly-one-of constraint enforces that webhook rows carry a
-- webhook_config_id, email rows carry email_recipients[], slack rows
-- carry slack_webhook_url.
--
-- Per internal design notes.

CREATE TABLE rule_alert_channels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id            UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL CHECK (channel IN ('webhook', 'email', 'slack')),
  enabled            BOOLEAN NOT NULL DEFAULT true,
  webhook_config_id  UUID REFERENCES webhook_configs(id) ON DELETE SET NULL,
  email_recipients   TEXT[],
  slack_webhook_url  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rac_exactly_one_of CHECK (
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

CREATE INDEX idx_rule_alert_channels_rule ON rule_alert_channels(rule_id);
CREATE INDEX idx_rule_alert_channels_webhook_config ON rule_alert_channels(webhook_config_id)
  WHERE webhook_config_id IS NOT NULL;

ALTER TABLE rule_alert_channels ENABLE ROW LEVEL SECURITY;

-- RLS via the parent rule's builder_id. EXISTS check is correct here
-- because rules.builder_id is the tenant boundary.
CREATE POLICY rule_alert_channels_isolation ON rule_alert_channels
  USING (
    EXISTS (
      SELECT 1 FROM rules r
       WHERE r.id = rule_id
         AND r.builder_id = current_setting('app.builder_id', true)::uuid
    )
  );
