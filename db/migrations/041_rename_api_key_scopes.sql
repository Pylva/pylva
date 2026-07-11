-- Rename API key scopes to builder-facing names.
-- migration-preflight: ok T7 legacy literals are only allowed by the temporary transition constraint during scope rename rollout.
--
-- Existing plaintext keys keep working: key_hash/key_id are unchanged, and
-- only the authorization scope value is remapped.

-- Keep a DB-level guard in place even if this file is applied without an
-- outer transaction. The repo runner wraps each migration in sql.begin(), but
-- production operators may apply this one file directly during rollout.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'api_keys'::regclass
      AND conname = 'api_keys_scope_transition_check'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_transition_check
      CHECK (
        scope IN (
          'telemetry',
          'pricing_admin',
          'cost_sources_write',
          'agent_sdk',
          'admin_api',
          'data_import'
        )
      ) NOT VALID;
  END IF;
END$$;

ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_scope_transition_check;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_check;

UPDATE api_keys
SET scope = CASE scope
  WHEN 'telemetry' THEN 'agent_sdk'
  WHEN 'pricing_admin' THEN 'admin_api'
  WHEN 'cost_sources_write' THEN 'data_import'
  ELSE scope
END;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'api_keys'::regclass
      AND conname = 'api_keys_scope_check'
  ) THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_scope_check
      CHECK (scope IN ('agent_sdk', 'admin_api', 'data_import')) NOT VALID;
  END IF;
END$$;

ALTER TABLE api_keys VALIDATE CONSTRAINT api_keys_scope_check;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_scope_transition_check;
