-- B2a Phase 0a — Migration 019
-- Audit log actor_user_id: who (human) performed the action? System/cron
-- actions remain NULL. Existing rows (from B0/B1) all predate the org
-- model; they're actor_type='api_key' or 'system' which don't map to a
-- user — leaving NULL is correct.
--
-- Per internal design notes (migration 019) + §2g (D38).
--
-- Note: audit_log is partitioned. ALTER TABLE on a partitioned parent
-- cascades to children automatically in PG 16, so one statement suffices.

ALTER TABLE audit_log
  ADD COLUMN actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_audit_log_actor_user ON audit_log(actor_user_id, timestamp)
  WHERE actor_user_id IS NOT NULL;
