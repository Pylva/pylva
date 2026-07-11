-- Track 1 PR 1.5 — invoice idempotency hardening + draft_key dedupe.
-- Per internal design notes (O4 + O28).
--
-- ⚠ DO NOT APPLY WITHOUT MAINTENANCE WINDOW ⚠
-- This migration drops-and-recreates `invoice_idempotency`. The table is
-- short-lived (24h TTL via /api/cron/purge-invoice-idempotency) so the
-- impact is minimal, but in-flight POSTs that have claimed a key without
-- yet committing the invoice id will lose their claim.
--
-- Cutover steps (operator):
--   1. Pause /api/v1/billing/invoices traffic at the ALB or via a brief
--      `ENABLE_BILLING_WRITES=false` toggle (TODO: add flag if not present).
--   2. Apply this migration via `pnpm db:setup` or:
--      `psql --single-transaction -v ON_ERROR_STOP=1 -f db/migrations/031_*.sql`.
--   3. Re-enable traffic.
--   4. Schedule the matching code deploy (idempotency.ts + invoice-
--      generator.ts + monthly-drafts.ts) — landed in a follow-up PR after
--      this migration runs.
--
-- What this migration does:
--   * Replaces the single-column PK on `invoice_idempotency` with a
--     composite (builder_id, idempotency_key) so two distinct builders
--     can use the same Idempotency-Key without collision (per O4).
--   * Adds `invoices.draft_key TEXT` + unique partial index
--     `(builder_id, draft_key) WHERE draft_key IS NOT NULL`. Monthly cron
--     will populate this with a deterministic key per (builder, customer,
--     period_start, period_end, pricing_version, slice_idx) so re-running
--     the cron is idempotent (per O28).

-- 1) invoice_idempotency: composite PK.
DROP TABLE IF EXISTS invoice_idempotency CASCADE;

CREATE TABLE invoice_idempotency (
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  request_hash    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (builder_id, idempotency_key)
);

CREATE INDEX idx_invoice_idempotency_created
  ON invoice_idempotency(created_at);

ALTER TABLE invoice_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_idempotency_isolation ON invoice_idempotency
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-- 2) invoices.draft_key + uniqueness for active draft rows.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS draft_key TEXT;

-- Partial unique: only enforced where draft_key is set. Allows historical
-- non-cron invoices (no draft_key) and finalized ones to coexist freely.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_builder_draft_key
  ON invoices(builder_id, draft_key)
  WHERE draft_key IS NOT NULL;
