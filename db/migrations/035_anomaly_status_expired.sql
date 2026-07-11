-- Migration 035 — widen anomaly_events.status CHECK to allow 'expired'.
--
-- Per internal design notes (O22):
-- recommendations expire after 30 days; the cron flips matching anomaly
-- rows to status='expired'. Migration 028 declared the column with
-- CHECK (status IN ('open','dismissed','converted_to_rule')) and
-- migration 030's status='open' partial unique index encodes the same
-- vocabulary — but src/lib/anomaly/repository.ts:expireStaleAnomalies
-- writes 'expired'. Without this migration, every detect-anomalies cron
-- run that finds a 30-day-old open anomaly throws check_violation;
-- runner.ts swallows it as "non-fatal", so the cron continues but no
-- row ever transitions to expired. The status='open' partial unique
-- index then permanently blocks re-detection of the same shape.
--
-- Idempotent: safe to apply on environments that already received the
-- widening manually.

ALTER TABLE anomaly_events DROP CONSTRAINT IF EXISTS anomaly_events_status_check;
ALTER TABLE anomaly_events ADD CONSTRAINT anomaly_events_status_check
  CHECK (status IN ('open', 'dismissed', 'converted_to_rule', 'expired'));
