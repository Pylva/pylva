-- Pylva ClickHouse Schema Migration 002 (B1 — Decision D2)
-- Makes cost_usd Nullable and adds pricing_status so ingest can mark unpriced events
-- as `needs_input` or `pending` without pretending an unknown cost is zero.
--
-- NULL backfill carve-out (D4): `cost_usd` becomes Nullable; the only allowed mutation
-- is NULL → value via the hourly backfill job. value → new-value remains forbidden.
--
-- cost_daily_agg sums ifNull(cost_usd, 0), so unpriced events remain visible
-- in event counts without poisoning aggregate inserts.

ALTER TABLE cost_events
  MODIFY COLUMN cost_usd Nullable(Decimal(10,6));

ALTER TABLE cost_events
  ADD COLUMN IF NOT EXISTS pricing_status LowCardinality(String) DEFAULT 'priced'
  COMMENT 'priced | needs_input | pending';
