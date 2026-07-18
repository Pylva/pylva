-- Keep legacy telemetry instants independent of the ClickHouse server timezone.
--
-- The ingest path serializes JavaScript UTC dates as `YYYY-MM-DD HH:MM:SS` for
-- ClickHouse. A bare DateTime column interprets that timezone-less value in the
-- server timezone, which shifts the stored instant on non-UTC deployments and
-- makes the canonical UTC dashboard window miss freshly ingested events.
-- DateTime stores epoch seconds internally, so adding the explicit UTC timezone
-- preserves existing instants while making all future inserts deterministic.

ALTER TABLE cost_events
  MODIFY COLUMN IF EXISTS timestamp DateTime('UTC');
