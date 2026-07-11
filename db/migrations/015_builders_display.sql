-- B2a Phase 0a — Migration 015
-- OAuth first-login enriches the builder with display metadata pulled
-- from the provider profile (GitHub avatar_url, Google name). These
-- are cosmetic (dashboard header + org switcher), not load-bearing.
--
-- Per internal design notes (migration 015) + §3.1.

ALTER TABLE builders
  ADD COLUMN display_name TEXT,
  ADD COLUMN avatar_url   TEXT;

-- Existing rows: leave null; dashboard falls back to builders.name/email
-- when display_name is null (D20 vocab doesn't apply to builder self —
-- only to the "End-user" vs customer_id distinction).
