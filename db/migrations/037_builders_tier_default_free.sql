-- Frontend launch §5 — set the default for `builders.tier` back to `'free'`.
-- Migration 032 set it to `'pro'` for an internal pilot; self-serve signup
-- requires unpaid workspaces to start on free. Paid tier changes are driven
-- by Stripe webhook sync (see migration 034 stripe_price_tier_map).
ALTER TABLE builders ALTER COLUMN tier SET DEFAULT 'free';
