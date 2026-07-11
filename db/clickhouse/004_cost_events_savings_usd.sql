-- Track 3 PR 3.1 — savings_usd column on cost_events.
-- Per internal design notes (O5).
--
-- Routed-cost attribution: when an SDK rule mutates the LLM model used
-- for a call (model_routing rule), ingest computes the *actual* cost via
-- the routed model and writes `savings_usd = original_estimate - actual`
-- (clamped >= 0) into this column. Existing `cost_usd` always reflects
-- what was billed; `savings_usd` is the rule-attributable delta.
--
-- Default 0 preserves semantics for historical rows + non-routed events.

ALTER TABLE cost_events
  ADD COLUMN IF NOT EXISTS savings_usd Float64 DEFAULT 0;
