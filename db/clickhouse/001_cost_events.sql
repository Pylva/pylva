-- Pylva ClickHouse Schema
-- cost_events: Append-only telemetry storage
-- cost_daily_agg: Materialized view for sub-millisecond dashboard queries
-- Spec references: Section 4.6

-- Decision #19: Separate builder_id column for efficient builder-scoped queries

CREATE TABLE IF NOT EXISTS cost_events (
  timestamp             DateTime('UTC'),
  builder_id            String,                    -- Separate column for efficient filtering
  trace_id              UUID,
  span_id               UUID,
  parent_span_id        Nullable(UUID),
  customer_id           String,                    -- Composite: {builder_id}:{customer_id}
  provider              LowCardinality(String),
  model                 Nullable(String),
  operation             LowCardinality(String),
  step_name             Nullable(String),
  tokens_in             UInt32,
  tokens_out            UInt32,
  cost_usd              Decimal(10,6),             -- Computed server-side, NOT from SDK
  latency_ms            UInt32,
  status                LowCardinality(String),
  cost_source           LowCardinality(String),    -- auto | configured
  instrumentation_tier  LowCardinality(String),    -- sdk_wrapper | reported
  metric                Nullable(String),
  metric_value          Nullable(Float64),
  stream_aborted        UInt8 DEFAULT 0,
  abort_savings         Decimal(10,6) DEFAULT 0,
  metadata              String DEFAULT ''
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (builder_id, customer_id, timestamp)
TTL timestamp + INTERVAL 1 YEAR;


-- Materialized view for daily aggregations
-- B0 plan version: GROUP BY includes builder_id (corrects spec omission)
CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (builder_id, customer_id, day, provider, model, step_name)
SETTINGS allow_nullable_key = 1
AS SELECT
  toDate(timestamp) AS day,
  builder_id,
  customer_id,
  provider,
  model,
  step_name,
  sum(tokens_in) AS total_tokens_in,
  sum(tokens_out) AS total_tokens_out,
  sum(ifNull(cost_usd, toDecimal64(0, 6))) AS total_cost_usd,
  count() AS event_count,
  avg(latency_ms) AS avg_latency_ms
FROM cost_events
GROUP BY day, builder_id, customer_id, provider, model, step_name;
