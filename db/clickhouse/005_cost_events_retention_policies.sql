-- AWS Step 11 retention hardening.
--
-- Raw cost_events already expires after 1 year in 001_cost_events.sql. Keep
-- that high-volume cap explicit until 007's per-row retention TTL wins later
-- in the same lexicographic setup pass. Aggregate retention lives in 008/009
-- because ClickHouse 24.8 rejects ALTER ... MODIFY TTL on engine-backed
-- MaterializedView storage.

ALTER TABLE cost_events
  MODIFY TTL timestamp + INTERVAL 1 YEAR;
