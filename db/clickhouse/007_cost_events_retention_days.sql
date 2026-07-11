-- Per-row cost_events retention stamped at ingest from the builder tier.
--
-- Deploy order: code that sends the new JSONEachRow fields requires these
-- columns to exist. Apply this DDL before deploying that ingest path.
--
-- db/setup.ts runs ClickHouse files lexicographically; this file runs after
-- 005_cost_events_retention_policies.sql in the same setup pass, so this TTL
-- wins. Legacy rows keep DEFAULT 365, preserving today's 1-year behavior.

ALTER TABLE cost_events
  ADD COLUMN IF NOT EXISTS retention_days UInt16 DEFAULT 365
  COMMENT 'telemetry retention stamped at ingest from tier; 18250 = unlimited sentinel';

ALTER TABLE cost_events
  ADD COLUMN IF NOT EXISTS billing_retention_days UInt16 DEFAULT 365
  COMMENT 'billing-aggregate retention; projected into daily agg targets by later MVs';

ALTER TABLE cost_events
  MODIFY TTL timestamp + toIntervalDay(retention_days);
