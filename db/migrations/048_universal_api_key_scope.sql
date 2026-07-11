-- One key does everything: normalize all API key scopes to 'universal'.
-- migration-preflight: ok — legacy scope literals below are the values being
-- migrated away from, kept insertable for previous-release compatibility.
--
-- DEPLOY ORDER: ship app code first, then run this. New code never branches
-- on scope, so it works against legacy rows; old code has no alias for
-- 'universal' and would 403 every migrated key, so migrating first breaks
-- live machine traffic. (Until this runs, new code minting 'universal' fails
-- the 041 constraint and surfaces the route's "schema out of date" message —
-- key creation degrades, existing traffic does not.)
--
-- ROLLBACK: restore the original scopes from the backup table, then redeploy
-- the previous release (the widened constraint still admits legacy values):
--   UPDATE api_keys k SET scope = b.scope
--   FROM _048_api_keys_scope_backup b WHERE k.key_id = b.key_id;
--
-- key_id/key_hash are untouched — every existing plaintext key keeps
-- authenticating. The backup table is dropped by a future tightening
-- migration once no pre-048 release exists anywhere.

CREATE TABLE IF NOT EXISTS _048_api_keys_scope_backup AS
  SELECT key_id, scope FROM api_keys WHERE scope <> 'universal';

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_check;

-- Same constraint name as 041; NOT VALID + VALIDATE avoids the full-table
-- scan under the ACCESS EXCLUSIVE lock taken by ADD CONSTRAINT.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'api_keys'::regclass
      AND conname = 'api_keys_scope_check'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check
      CHECK (scope IN ('agent_sdk', 'admin_api', 'data_import', 'universal')) NOT VALID;
  END IF;
END$$;

ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_scope_check;

UPDATE api_keys SET scope = 'universal' WHERE scope <> 'universal';
