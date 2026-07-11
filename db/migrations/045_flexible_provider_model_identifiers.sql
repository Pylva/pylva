-- Flexible provider/model identifiers for TypeScript telemetry.
-- Provider and model names are exact runtime strings, capped at 255 chars by
-- shared ingest validation. This migration widens persisted lookup/log fields
-- that previously assumed a short closed provider list or 100-char model id.

ALTER TABLE llm_pricing
  ALTER COLUMN provider TYPE VARCHAR(255),
  ALTER COLUMN model TYPE VARCHAR(255);

ALTER TABLE rule_events
  ALTER COLUMN provider TYPE VARCHAR(255),
  ALTER COLUMN model_from TYPE VARCHAR(255),
  ALTER COLUMN model_to TYPE VARCHAR(255);

ALTER TABLE api_key_vault
  ALTER COLUMN provider TYPE VARCHAR(255);

ALTER TABLE custom_pricing
  ALTER COLUMN provider TYPE VARCHAR(255),
  ALTER COLUMN model TYPE VARCHAR(255);

ALTER TABLE pricing_onboarding_tasks
  ALTER COLUMN provider TYPE VARCHAR(255),
  ALTER COLUMN model TYPE VARCHAR(255);

ALTER TABLE cost_sources
  ALTER COLUMN display_name TYPE VARCHAR(255);
