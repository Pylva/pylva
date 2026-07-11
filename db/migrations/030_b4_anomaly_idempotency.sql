-- Migration 030 — anomaly_events idempotency.
--
-- Repeated cron runs MUST NOT duplicate an OPEN anomaly for the same
-- (builder, customer, source_type, period). The partial-unique scope on
-- status='open' is intentional: once an anomaly is dismissed or
-- converted_to_rule, the same shape recurring in a later period is a
-- legitimate new anomaly and must be allowed.
--
-- NULLS NOT DISTINCT (Postgres ≥15) lets builder-level anomalies (where
-- customer_id IS NULL) remain unique per period without a sentinel
-- value. Production runs Postgres 16.

CREATE UNIQUE INDEX uq_anomaly_events_open_period
  ON anomaly_events (builder_id, customer_id, source_type, period_start, period_end)
  NULLS NOT DISTINCT
  WHERE status = 'open';
