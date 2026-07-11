-- Pylva API Keys Scope Update (B1 — Decisions D9, D37)
-- Replaces scope CHECK constraint: drops 'vault' (BYOK deferred post-PMF),
-- adds 'pricing_admin' for B1 custom-pricing CRUD endpoint.
--
-- Order of operations so no row is ever out of compliance:
-- 1. Revoke any legacy vault-scoped keys (there should be none in production; seed-only).
-- 2. Drop the old constraint.
-- 3. Add the new constraint.
--
-- The api_key_vault table is preserved as a dormant artifact — BYOK may return post-PMF.

-- 1. Soft-revoke legacy vault scope keys.
UPDATE api_keys SET revoked_at = NOW() WHERE scope = 'vault' AND revoked_at IS NULL;

-- 2. Migrate any remaining vault rows to a safe placeholder so the new CHECK constraint is satisfiable.
--    (Keeps history; revoked keys cannot be validated, so the stored scope value is irrelevant for access control.)
UPDATE api_keys SET scope = 'telemetry' WHERE scope = 'vault';

-- 3. Swap the CHECK constraint.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_scope_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check
  CHECK (scope IN ('telemetry', 'pricing_admin'));
