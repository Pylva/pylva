-- Authoritative budget-control analytics projection.
--
-- The legacy `cost_events` table is an append-only MergeTree without an event
-- identity. Retrying an INSERT after a lost acknowledgement can therefore
-- create two physical rows and double every materialized-view contribution.
-- Controlled usage is projected into an additive, event-keyed table instead.
-- ReplacingMergeTree keeps compaction cheap, while the canonical grouped view
-- below makes an identical (event, payload hash) retry one logical row even
-- before a background merge. The hash remains part of the replacement key so
-- a conflicting payload for the same event identity cannot be erased before
-- reconciliation detects it.
--
-- Do not attach summing materialized views directly to the physical table:
-- they observe every retry before replacement. Consumers that need the
-- controlled stream must read `budget_cost_events_final` with
-- `payload_hash_count = 1`, or the compatible `cost_events_with_control` union
-- view (which applies that predicate itself). Authoritative outbox retries preserve
-- the immutable committed timestamp for an event, so timestamp is part of the
-- canonical grouping and physical sort key. That makes builder/time dashboard
-- predicates prune parts and primary-key granules before aggregation.

CREATE TABLE IF NOT EXISTS budget_cost_events (
  event_id                UUID,
  payload_hash            FixedString(64),
  timestamp               DateTime64(3, 'UTC'),
  builder_id              String,
  reservation_decision_id UUID TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  operation_id            UUID TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  trace_id                UUID TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  span_id                 UUID TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  parent_span_id          Nullable(UUID) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  customer_id             String,
  provider                LowCardinality(String),
  model                   Nullable(String),
  operation               LowCardinality(String) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  step_name               Nullable(String) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  tokens_in               UInt32,
  tokens_out              UInt32,
  cost_usd                Decimal(44,18),
  pricing_status          LowCardinality(String),
  latency_ms              UInt32 TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  status                  LowCardinality(String) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  cost_source             LowCardinality(String) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  instrumentation_tier    LowCardinality(String) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  metric                  Nullable(String),
  metric_value            Nullable(Decimal(44,18)),
  stream_aborted          UInt8 TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  abort_savings           Decimal(44,18) TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  savings_usd             Float64 DEFAULT 0 TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  is_demo                 UInt8 TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  retention_days          UInt16,
  billing_retention_days  UInt16,
  metadata                String TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days),
  inserted_at             DateTime64(3, 'UTC') DEFAULT now64(3),
  INDEX budget_cost_events_event_id_bf event_id TYPE bloom_filter(0.01) GRANULARITY 1
) ENGINE = ReplacingMergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (builder_id, timestamp, event_id, payload_hash)
-- This event-keyed table is also the exact controlled billing read model. Its
-- typed facts must therefore survive through the immutable billing horizon;
-- using telemetry retention here can delete day-one usage before a monthly
-- invoice while PostgreSQL's verified watermark remains green.
TTL toDateTime(timestamp, 'UTC') + toIntervalDay(billing_retention_days);

CREATE VIEW IF NOT EXISTS budget_cost_events_final AS
SELECT
  event_id,
  any(payload_hash) AS payload_hash,
  uniqExact(budget_cost_events.payload_hash) AS payload_hash_count,
  timestamp,
  builder_id,
  any(reservation_decision_id) AS reservation_decision_id,
  any(operation_id) AS operation_id,
  any(trace_id) AS trace_id,
  any(span_id) AS span_id,
  any(parent_span_id) AS parent_span_id,
  any(customer_id) AS customer_id,
  any(provider) AS provider,
  any(model) AS model,
  any(operation) AS operation,
  any(step_name) AS step_name,
  any(tokens_in) AS tokens_in,
  any(tokens_out) AS tokens_out,
  any(cost_usd) AS cost_usd,
  any(pricing_status) AS pricing_status,
  any(latency_ms) AS latency_ms,
  any(status) AS status,
  any(cost_source) AS cost_source,
  any(instrumentation_tier) AS instrumentation_tier,
  any(metric) AS metric,
  any(metric_value) AS metric_value,
  any(stream_aborted) AS stream_aborted,
  any(abort_savings) AS abort_savings,
  any(savings_usd) AS savings_usd,
  any(is_demo) AS is_demo,
  any(retention_days) AS retention_days,
  any(billing_retention_days) AS billing_retention_days,
  any(metadata) AS metadata,
  max(inserted_at) AS inserted_at
FROM budget_cost_events
GROUP BY builder_id, timestamp, event_id;

-- A read-compatible union for analytics paths that intentionally include both
-- legacy SDK telemetry and authoritative controlled commits. Extra identity
-- columns are nullable for legacy events; existing named-column queries remain
-- source-compatible. Decimal widening prevents valid NUMERIC(44,18) actual
-- costs from overflowing the legacy Decimal(10,6) representation.
CREATE VIEW IF NOT EXISTS cost_events_with_control AS
SELECT
  toDateTime64(timestamp, 3, 'UTC') AS timestamp,
  builder_id,
  trace_id,
  span_id,
  parent_span_id,
  customer_id,
  toString(provider) AS provider,
  model,
  toString(operation) AS operation,
  step_name,
  tokens_in,
  tokens_out,
  CAST(cost_usd, 'Nullable(Decimal(44,18))') AS cost_usd,
  toString(pricing_status) AS pricing_status,
  latency_ms,
  toString(status) AS status,
  toString(cost_source) AS cost_source,
  toString(instrumentation_tier) AS instrumentation_tier,
  metric,
  CAST(metric_value, 'Nullable(Float64)') AS metric_value,
  stream_aborted,
  CAST(abort_savings, 'Decimal(44,18)') AS abort_savings,
  savings_usd,
  is_demo,
  retention_days,
  billing_retention_days,
  metadata,
  CAST(NULL, 'Nullable(UUID)') AS event_id,
  CAST(NULL, 'Nullable(UUID)') AS reservation_decision_id,
  CAST(NULL, 'Nullable(UUID)') AS operation_id,
  CAST(NULL, 'Nullable(FixedString(64))') AS payload_hash,
  'legacy' AS event_origin
FROM cost_events
UNION ALL
SELECT
  timestamp,
  builder_id,
  trace_id,
  span_id,
  parent_span_id,
  customer_id,
  toString(provider) AS provider,
  model,
  toString(operation) AS operation,
  step_name,
  tokens_in,
  tokens_out,
  CAST(cost_usd, 'Nullable(Decimal(44,18))') AS cost_usd,
  toString(pricing_status) AS pricing_status,
  latency_ms,
  toString(status) AS status,
  toString(cost_source) AS cost_source,
  toString(instrumentation_tier) AS instrumentation_tier,
  metric,
  CAST(metric_value, 'Nullable(Float64)') AS metric_value,
  stream_aborted,
  abort_savings,
  savings_usd,
  is_demo,
  retention_days,
  billing_retention_days,
  metadata,
  CAST(event_id, 'Nullable(UUID)') AS event_id,
  CAST(reservation_decision_id, 'Nullable(UUID)') AS reservation_decision_id,
  CAST(operation_id, 'Nullable(UUID)') AS operation_id,
  CAST(payload_hash, 'Nullable(FixedString(64))') AS payload_hash,
  'authoritative_budget' AS event_origin
FROM budget_cost_events_final
WHERE payload_hash_count = 1
  AND timestamp + toIntervalDay(retention_days) > now();
