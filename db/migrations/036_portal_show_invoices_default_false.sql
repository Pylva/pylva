-- Migration 036 — flip portal_configs.show_invoices default to FALSE.
--
-- Per internal design notes D7 — "Portal default
-- view = usage-only. Invoice views opt-in feature, off by default."
-- Migration 029 created the column with `DEFAULT TRUE`, the inverse of
-- D7. The portal page does not yet render invoices, so the impact is
-- latent — but every existing portal_configs row inherits the wrong
-- baseline, and the moment invoice UI lands, builder-confidential
-- billing data leaks to customers without opt-in.
--
-- Two-step:
--   1. Flip the default for new rows.
--   2. Backfill existing rows that have never been touched (still at
--      the old default). We can't perfectly distinguish "owner left it
--      at default" from "owner explicitly enabled invoices", but: the
--      column was added 1 day before this migration, the portal
--      invoice UI doesn't exist yet, and D7 is the consent contract.
--      Conservative reset is the safer interpretation.

ALTER TABLE portal_configs ALTER COLUMN show_invoices SET DEFAULT FALSE;

UPDATE portal_configs SET show_invoices = FALSE WHERE show_invoices = TRUE;
