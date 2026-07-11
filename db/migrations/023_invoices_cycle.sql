-- B2b Phase 0b — Migration 023
-- Extend invoices for B2b: billing-cycle grouping (auto-split on pricing
-- boundary — D8), pricing version reference for historical reproducibility,
-- has_unpriced_events flag (D14 — invoice stays draft until builder
-- accepts + finalizes), and timestamps the Stripe webhook consumer updates
-- (paid_at, payment_failed_at, last_viewed_at).
--
-- period_start / period_end already exist on invoices from migration 002
-- (NOT NULL). We leave those alone — B2b slice logic writes into them.
--
-- Per internal design notes (migration 023) + §3.3 + §3.4.

ALTER TABLE invoices
  ADD COLUMN billing_cycle_id     UUID,
  ADD COLUMN pricing_version      INT,
  ADD COLUMN has_unpriced_events  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN paid_at              TIMESTAMPTZ,
  ADD COLUMN payment_failed_at    TIMESTAMPTZ,
  ADD COLUMN last_viewed_at       TIMESTAMPTZ;

CREATE INDEX idx_invoices_cycle ON invoices(builder_id, billing_cycle_id)
  WHERE billing_cycle_id IS NOT NULL;
