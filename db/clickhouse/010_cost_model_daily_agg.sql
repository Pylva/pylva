-- Model/day aggregate used by the dashboard models page.
--
-- cost_daily_agg_v2 has provider/model dimensions but no is_demo dimension, so
-- it cannot serve the default demo-excluded dashboard path. This aggregate keeps
-- model breakdown reads off raw cost_events while preserving demo isolation.

CREATE TABLE IF NOT EXISTS cost_model_daily_agg (
  day                    Date,
  builder_id             String,
  is_demo                UInt8,
  provider               LowCardinality(String),
  model                  Nullable(String),
  total_cost_usd         SimpleAggregateFunction(sum, Decimal(38,6)),
  total_tokens_in        SimpleAggregateFunction(sum, UInt64),
  total_tokens_out       SimpleAggregateFunction(sum, UInt64),
  call_count             SimpleAggregateFunction(sum, UInt64),
  billing_retention_days SimpleAggregateFunction(max, UInt16) DEFAULT 365
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (builder_id, is_demo, day, provider, model)
TTL day + toIntervalDay(billing_retention_days)
SETTINGS allow_nullable_key = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS cost_model_daily_agg_mv
TO cost_model_daily_agg
AS SELECT
  toDate(timestamp) AS day,
  builder_id,
  is_demo,
  provider,
  model,
  CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)') AS total_cost_usd,
  sum(tokens_in) AS total_tokens_in,
  sum(tokens_out) AS total_tokens_out,
  count() AS call_count,
  max(billing_retention_days) AS billing_retention_days
FROM cost_events
GROUP BY day, builder_id, is_demo, provider, model;

CREATE TABLE IF NOT EXISTS cost_model_daily_agg_backfill_status (
  checked_at           DateTime64(6) DEFAULT now64(6),
  scope                LowCardinality(String),
  status               LowCardinality(String),
  reason               LowCardinality(String),
  day                  Nullable(Date),
  source_cost_usd      Decimal(38,6),
  aggregate_cost_usd   Decimal(38,6),
  source_tokens_in     UInt64,
  aggregate_tokens_in  UInt64,
  source_tokens_out    UInt64,
  aggregate_tokens_out UInt64,
  source_call_count    UInt64,
  aggregate_call_count UInt64
) ENGINE = MergeTree()
ORDER BY (checked_at, scope);
