-- Track 4 PR 4.1 — portal_sessions table.
-- Per internal design notes
-- (O7 + O8).
--
-- Token model:
--   * Long-lived link token (portal_links.jti) is the permanent
--     reference the builder shares with their customer.
--   * On first visit, the link is exchanged for a session row here.
--     issued_at = now, last_activity_at = now, hard_expires_at = now+8h.
--   * Subsequent requests check: now <= hard_expires_at AND
--     now - last_activity_at <= 8h. Sliding within window updates
--     last_activity_at on each request. After 8h continuous, force a
--     fresh exchange.
--   * Revoking the underlying link cascades — sessions tied to that
--     jti are invalid even if not yet hard-expired (we filter on the
--     join).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS portal_sessions (
  jti               UUID PRIMARY KEY,
  builder_id        UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  link_id           UUID NOT NULL REFERENCES portal_links(id) ON DELETE CASCADE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hard_expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_portal_sessions_builder_customer
  ON portal_sessions(builder_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_hard_expires
  ON portal_sessions(hard_expires_at);

ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_sessions_isolation ON portal_sessions;
CREATE POLICY portal_sessions_isolation ON portal_sessions
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
