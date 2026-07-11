-- B2b Phase 0b — Migration 021
-- Invoice idempotency cache: builder-supplied Idempotency-Key → claimed invoice.
-- TTL 24h (swept by cron /api/cron/purge-invoice-idempotency).
--
-- Same key + same body_hash → existing invoice_id returned (no second Stripe call).
-- Same key + different body_hash → 409 conflict (builder bug, don't silently repair).
-- Key older than 24h → new invoice allowed (cron purges).
--
-- Per internal design notes (migration 021) + §5.2 I-T2-1 + D12.

CREATE TABLE invoice_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  invoice_id      UUID REFERENCES invoices(id) ON DELETE SET NULL,
  request_hash    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoice_idempotency_builder ON invoice_idempotency(builder_id);
CREATE INDEX idx_invoice_idempotency_created ON invoice_idempotency(created_at);

ALTER TABLE invoice_idempotency ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoice_idempotency_isolation ON invoice_idempotency
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
