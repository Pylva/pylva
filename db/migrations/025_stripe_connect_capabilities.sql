-- B2b Phase 0b — Migration 025
-- stripe_connect: widen status CHECK for the Connect Onboarding flow and
-- add capabilities_ok flag that gates invoice generation (I-T2-14).
--
-- New status values (matches §3.1 of b2b plan):
--   not_connected                    — never connected
--   pending_onboarding               — account created, account-link redirected
--   connected                        — account + capabilities.card_payments=active + payouts_enabled
--   connected_pending_capabilities   — account connected but capabilities still pending
--   disconnected                     — explicit disconnect; capabilities soft-disabled via Stripe
--
-- Backward-compat: existing 'pending' rows (old onboarding flow, if any) are
-- mapped to 'pending_onboarding'. Existing 'disabled' rows map to
-- 'disconnected'. Existing 'connected' rows get capabilities_ok=true (we
-- preserve legacy optimistic state; operators can re-sync from Stripe).
--
-- Per internal design notes §3.1 + §5.2 I-T2-14 + plan gap §3.2.

-- Widen the status column first — 'connected_pending_capabilities' is 31 chars,
-- the VARCHAR(20) from migration 002 would reject it.
ALTER TABLE stripe_connect ALTER COLUMN status TYPE VARCHAR(40);

-- Then rename legacy values so they pass the new CHECK.
UPDATE stripe_connect SET status = 'pending_onboarding' WHERE status = 'pending';
UPDATE stripe_connect SET status = 'disconnected'       WHERE status = 'disabled';

-- Drop the old CHECK (auto-generated name: stripe_connect_status_check).
ALTER TABLE stripe_connect DROP CONSTRAINT stripe_connect_status_check;

-- Apply the widened CHECK.
ALTER TABLE stripe_connect
  ADD CONSTRAINT stripe_connect_status_check
    CHECK (status IN (
      'not_connected',
      'pending_onboarding',
      'connected',
      'connected_pending_capabilities',
      'disconnected'
    ));

-- Add capabilities_ok column; backfill 'connected' rows to true.
ALTER TABLE stripe_connect
  ADD COLUMN capabilities_ok BOOLEAN NOT NULL DEFAULT false;

UPDATE stripe_connect SET capabilities_ok = true WHERE status = 'connected';
