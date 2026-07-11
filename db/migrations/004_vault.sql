-- Pylva BYOK Vault Schema
-- Migration 004: Encrypted API key vault with RLS
-- Spec references: Section 4.14
-- AES-256-GCM encryption, per-builder KMS master key (envelope encryption)

-------------------------------------------------------------------
-- api_key_vault: BYOK encrypted API key storage
-------------------------------------------------------------------
CREATE TABLE api_key_vault (
  id              SERIAL PRIMARY KEY,
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id     VARCHAR(255),
  provider        VARCHAR(50) NOT NULL,
  encrypted_key   BYTEA NOT NULL,
  nonce           BYTEA NOT NULL,            -- 96-bit, unique per operation
  auth_tag        BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at      TIMESTAMPTZ,
  UNIQUE (builder_id, customer_id, provider)
);

CREATE INDEX idx_vault_builder ON api_key_vault(builder_id);
CREATE INDEX idx_vault_lookup ON api_key_vault(builder_id, customer_id, provider);

ALTER TABLE api_key_vault ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_key_vault_isolation ON api_key_vault
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
