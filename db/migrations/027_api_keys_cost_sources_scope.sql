-- B3-T4a follow-up — extend api_keys.scope CHECK to cover cost_sources_write.
--
-- Migration 008 locked scope to ('telemetry', 'pricing_admin'). B3-T4a added
-- the COST_SOURCES_WRITE scope (pv_cli_* keys) in shared types + application
-- code but shipped without widening the DB constraint — `generateApiKey(...,
-- 'cost_sources_write')` currently fails with api_keys_scope_check.
--
-- Per internal design notes (D27 — separate pv_cli_* key type).
--
-- Safe to run in a single step: the new constraint is a strict superset of the
-- old one, so no existing rows are invalidated.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scope_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check
  CHECK (scope IN ('telemetry', 'pricing_admin', 'cost_sources_write'));
