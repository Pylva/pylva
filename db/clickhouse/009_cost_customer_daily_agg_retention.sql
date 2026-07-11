-- Add billing-retention TTL to the customer/day aggregate.
--
-- db/setup.ts replays ClickHouse DDL lexicographically. Migration 006 creates
-- cost_customer_daily_agg_mv without billing_retention_days; this migration
-- upgrades the existing materialized view with MODIFY QUERY. MODIFY QUERY is
-- atomic, so there is no drop window or ingest capture gap, and replaying this
-- migration is idempotent. A one-time backfill is still required for aggregate
-- rows inserted before this migration ever ran.

ALTER TABLE cost_customer_daily_agg
  ADD COLUMN IF NOT EXISTS billing_retention_days SimpleAggregateFunction(max, UInt16) DEFAULT 365;

ALTER TABLE cost_customer_daily_agg_mv
MODIFY QUERY SELECT
  toDate(timestamp) AS day,
  builder_id,
  customer_id,
  is_demo,
  CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)') AS total_cost_usd,
  count() AS event_count,
  max(timestamp) AS last_seen_at,
  max(billing_retention_days) AS billing_retention_days
FROM cost_events
GROUP BY day, builder_id, customer_id, is_demo;

ALTER TABLE cost_customer_daily_agg
  MODIFY TTL day + toIntervalDay(billing_retention_days);
