-- B2a Phase 0a — Migration 014
-- Per-fire record of rule evaluation + delivery status across channels.
-- Fuels the /dashboard/rules/history page (§5.1 file 19) and the
-- audit trail ("rule X fired on Y, delivered Z of 3 channels").
--
-- Per internal design notes (migration 014) + §6.
--
-- delivery_status shape:
--   { "webhook": { "ok": true, "attempts": 1, "last_error": null },
--     "email":   { "ok": false, "attempts": 3, "last_error": "..." },
--     "slack":   { "ok": true, "attempts": 1, "last_error": null } }
-- A channel not configured for the rule is absent from the object.

CREATE TABLE alert_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id       UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  rule_id          UUID NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  fired_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload          JSONB NOT NULL,
  delivery_status  JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_alert_history_builder_fired ON alert_history(builder_id, fired_at DESC);
CREATE INDEX idx_alert_history_rule ON alert_history(rule_id, fired_at DESC);

ALTER TABLE alert_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY alert_history_isolation ON alert_history
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
