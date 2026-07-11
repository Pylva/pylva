-- B2a Phase 0a — Migration 016
-- Generalize webhook_dlq to any alert channel (webhook | email | slack).
-- Drops the FK-required semantics on webhook_config_id (channels like
-- email/slack don't have a webhook_config row) and adds a config snapshot
-- column so retries can replay against the config frozen at fire time
-- (I-T4a-3).
--
-- Migrating strategy: keep the existing webhook_dlq rows (if any) with
-- channel='webhook' + config_snapshot filled from webhook_configs via
-- a subquery. If webhook_config was already deleted we leave snapshot
-- as '{}' — retry surface in B2b will skip those.
--
-- Also changes payload to JSONB (previously TEXT JSON string) for index
-- support and partial JSON query convenience.
--
-- Per internal design notes (migration 016).

ALTER TABLE webhook_dlq
  ALTER COLUMN webhook_config_id DROP NOT NULL;

ALTER TABLE webhook_dlq
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'webhook'
    CHECK (channel IN ('webhook', 'email', 'slack')),
  ADD COLUMN channel_config_snapshot JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN event_type_v2 TEXT;

-- Backfill event_type_v2 from existing event_type, then swap.
UPDATE webhook_dlq SET event_type_v2 = event_type;
ALTER TABLE webhook_dlq DROP COLUMN event_type;
ALTER TABLE webhook_dlq RENAME COLUMN event_type_v2 TO event_type;
ALTER TABLE webhook_dlq ALTER COLUMN event_type SET NOT NULL;
ALTER TABLE webhook_dlq ALTER COLUMN event_type SET DEFAULT 'rule.fired';

-- Convert payload TEXT -> JSONB via USING cast. We assume existing rows
-- are valid JSON (inserted by v1 webhook code that already JSON.stringify'd).
ALTER TABLE webhook_dlq
  ALTER COLUMN payload TYPE JSONB USING payload::jsonb;

-- Back-fill channel_config_snapshot for existing rows from webhook_configs.
-- If webhook_config was deleted, snapshot remains '{}' (retry skips).
UPDATE webhook_dlq dlq
SET channel_config_snapshot = jsonb_build_object(
  'url', wc.url,
  'secret', wc.secret,
  'events', wc.events
)
FROM webhook_configs wc
WHERE dlq.webhook_config_id = wc.id
  AND dlq.channel_config_snapshot = '{}'::jsonb;

CREATE INDEX idx_webhook_dlq_channel ON webhook_dlq(channel, created_at DESC);
