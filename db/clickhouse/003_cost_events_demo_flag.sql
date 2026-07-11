-- B2a Phase 0a — Migration 020 (ClickHouse 003)
-- Demo flag for pre-seeded first-run data (D11). A column add is
-- cheap on MergeTree; default false preserves semantics for historical
-- rows. The dashboard auto-hide predicate uses this column via
-- `hasAnyRealEvents(builderId)` (see src/lib/clickhouse/dashboard-queries.ts).
--
-- Numbered 003 in the ClickHouse sequence (001=cost_events, 002=pricing_status);
-- corresponds to migration 020 in the Phase 0a plan's overall numbering.
--
-- Per internal design notes (migration 020) + §4.9.

ALTER TABLE cost_events
  ADD COLUMN IF NOT EXISTS is_demo UInt8 DEFAULT 0;

-- No backfill needed: existing rows are all real events (B1 shipped
-- without any demo data concept). The default 0 is correct.

-- Materialized view `cost_daily_agg` does NOT need is_demo — demo
-- builders have no "historical" dashboard view (they're always <30d
-- old). Queries that hit the aggregate explicitly OR with the live
-- cost_events table for today-included ranges (D21).
