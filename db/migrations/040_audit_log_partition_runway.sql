-- Migration 040 — refresh audit_log partition runway + fix the missing
-- partition manager.
--
-- BUG: audit_log is PARTITION BY RANGE (timestamp) (migration 001). Migration
-- 001 created partitions only through 2026-07-01; migration 032 hand-rolled a
-- finite 13-month runway and its comment claimed "the partition-manager cron
-- (existing infra) will append more". That cron never existed (the cron dir +
-- EventBridge schedules only had purge-audit-log, which DROPS old partitions),
-- and the written spec's "managed by pg_partman" was never wired up — pg_partman /
-- pg_cron are not installed. Once the seeded runway is exhausted, every
-- audit_log INSERT fails with `no partition of relation "audit_log" found for
-- row`. Because auditLog() runs inside the business write's RLS transaction
-- (src/lib/auth/audit-log.ts), that rolls back the whole operation: every
-- state-changing API call 500s and the audit trail is silently lost.
--
-- FIX (two parts):
--   1. This migration re-seeds the rolling window forward from NOW() so any DB
--      that applied 032 long ago regains a full year of runway on deploy,
--      without waiting for the first cron tick. Idempotent
--      (CREATE TABLE IF NOT EXISTS) — re-runs are no-ops.
--   2. The new /api/cron/ensure-audit-partitions route (this PR) is the
--      partition manager 032 assumed existed; it runs this same loop daily.
--      Keep the bounds/naming here identical to that route
--      (src/lib/db/audit-partitions.ts) and to migrations 001/032.

DO $$
DECLARE
  m_start DATE;
  m_end   DATE;
  pname   TEXT;
  i INT;
BEGIN
  -- current month + next 12 months (13 partitions), matching migration 032
  -- and AUDIT_PARTITION_MONTHS_AHEAD in src/lib/db/audit-partitions.ts.
  FOR i IN 0..12 LOOP
    m_start := (date_trunc('month', NOW()) + (i || ' months')::interval)::DATE;
    m_end   := (m_start + INTERVAL '1 month')::DATE;
    pname   := 'audit_log_y' || to_char(m_start, 'YYYY') || 'm' || to_char(m_start, 'MM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
      pname, m_start, m_end
    );
  END LOOP;
END$$;
