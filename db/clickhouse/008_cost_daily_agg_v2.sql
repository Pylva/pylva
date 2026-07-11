-- Explicit target table for daily aggregates with billing-retention TTL.
--
-- 001_cost_events.sql recreates the legacy engine-backed cost_daily_agg view
-- on every db/setup.ts pass. This file converges the final state by creating
-- the explicit TO-pattern replacement and then dropping the legacy view.

CREATE TABLE IF NOT EXISTS cost_daily_agg_v2 (
  day Date,
  builder_id String,
  customer_id String,
  provider LowCardinality(String),
  model Nullable(String),
  step_name Nullable(String),
  billing_retention_days UInt16,
  total_tokens_in UInt64,
  total_tokens_out UInt64,
  total_cost_usd Decimal(38,6),
  event_count UInt64,
  avg_latency_ms Float64
) ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (builder_id, customer_id, day, provider, model, step_name, billing_retention_days)
TTL day + toIntervalDay(billing_retention_days)
SETTINGS allow_nullable_key = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg_v2_mv
TO cost_daily_agg_v2
AS SELECT
  toDate(timestamp) AS day,
  builder_id,
  customer_id,
  provider,
  model,
  step_name,
  billing_retention_days,
  sum(tokens_in) AS total_tokens_in,
  sum(tokens_out) AS total_tokens_out,
  sum(ifNull(cost_usd, toDecimal64(0, 6))) AS total_cost_usd,
  count() AS event_count,
  avg(latency_ms) AS avg_latency_ms -- Replicates 001's SummingMergeTree average behavior.
FROM cost_events
GROUP BY builder_id, customer_id, day, provider, model, step_name, billing_retention_days;

DROP VIEW IF EXISTS cost_daily_agg;
