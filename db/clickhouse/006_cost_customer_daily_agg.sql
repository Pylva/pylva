-- Customer/day aggregate used by dashboard end-user lists.
--
-- cost_daily_agg predates demo rows and cannot filter is_demo. This table keeps
-- the dashboard's default demo-excluded reads off raw cost_events while
-- preserving customer-level spend, event counts, and last-seen timestamps.

CREATE TABLE IF NOT EXISTS cost_customer_daily_agg (
  day              Date,
  builder_id       String,
  customer_id      String,
  is_demo          UInt8,
  total_cost_usd   SimpleAggregateFunction(sum, Decimal(38,6)),
  event_count      SimpleAggregateFunction(sum, UInt64),
  last_seen_at     SimpleAggregateFunction(max, DateTime)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (builder_id, is_demo, day, customer_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS cost_customer_daily_agg_mv
TO cost_customer_daily_agg
AS SELECT
  toDate(timestamp) AS day,
  builder_id,
  customer_id,
  is_demo,
  CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)') AS total_cost_usd,
  count() AS event_count,
  max(timestamp) AS last_seen_at
FROM cost_events
GROUP BY day, builder_id, customer_id, is_demo;
