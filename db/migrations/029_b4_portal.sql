-- B4-0b — Migration 029
-- Replaces the B0-stub portal_configs / portal_links shapes with the B4 v2.0
-- typed columns, and adds two new tables (portal_access_grants +
-- portal_domains) for OAuth allowlist management and self-serve custom
-- domains.
--
-- Production has zero rows in portal_configs / portal_links (B0 stubs were
-- never populated), so DROP COLUMN + ADD COLUMN is safe. RLS policies are
-- preserved across the ALTERs. CHECK constraints are the spec-locked
-- literal sets; widen the underlying VARCHAR width BEFORE adding any new
-- enum value in a follow-up migration.

-------------------------------------------------------------------
-- portal_configs — replace JSONB-blob fields with typed columns
-------------------------------------------------------------------
ALTER TABLE portal_configs DROP COLUMN branding;
ALTER TABLE portal_configs DROP COLUMN features;
ALTER TABLE portal_configs DROP COLUMN auth_type;
ALTER TABLE portal_configs DROP COLUMN custom_domain;

ALTER TABLE portal_configs
  ADD COLUMN company_name              TEXT,
  ADD COLUMN logo_url                  TEXT,
  ADD COLUMN primary_color             TEXT,
  ADD COLUMN secondary_color           TEXT,
  ADD COLUMN accent_color              TEXT,
  ADD COLUMN cost_display_mode         VARCHAR(20)  NOT NULL DEFAULT 'usd'
                                          CHECK (cost_display_mode IN ('usd', 'credits')),
  ADD COLUMN credit_label              TEXT NOT NULL DEFAULT 'credits',
  ADD COLUMN visibility_level          VARCHAR(40)  NOT NULL DEFAULT 'aggregate_only'
                                          CHECK (visibility_level IN ('aggregate_only', 'category_model', 'step_level')),
  ADD COLUMN invoice_detail_level      VARCHAR(20)  NOT NULL DEFAULT 'summary_only'
                                          CHECK (invoice_detail_level IN ('summary_only', 'line_items', 'full')),
  ADD COLUMN show_budget_progress      BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN show_usage_trend          BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN show_invoices             BOOLEAN      NOT NULL DEFAULT TRUE,
  ADD COLUMN show_non_llm_sources      BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN allowed_iframe_origins    TEXT[]       NOT NULL DEFAULT '{}',
  -- OAuth provider config: encrypted client_secret, issuer URL, scopes,
  -- enabled flag. Null until the builder configures portal OAuth in B4-6.
  ADD COLUMN oauth_config              JSONB;

-------------------------------------------------------------------
-- portal_links — replace JWT token blob with hash + JTI revocation shape
-------------------------------------------------------------------
ALTER TABLE portal_links DROP COLUMN type;
ALTER TABLE portal_links DROP COLUMN token;

-- portal_links has zero rows in production (B0 stubs were never populated),
-- so the new columns can be NOT NULL without DEFAULT. Application code
-- always supplies these values when issuing a portal link.
ALTER TABLE portal_links
  ADD COLUMN jti                UUID         NOT NULL UNIQUE,
  ADD COLUMN token_hash         TEXT         NOT NULL,
  ADD COLUMN link_type          VARCHAR(20)  NOT NULL DEFAULT 'standard'
                                  CHECK (link_type IN ('standard', 'single_use')),
  ADD COLUMN status             VARCHAR(20)  NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  ADD COLUMN first_used_at      TIMESTAMPTZ,
  ADD COLUMN grace_expires_at   TIMESTAMPTZ,
  ADD COLUMN revoked_at         TIMESTAMPTZ,
  ADD COLUMN created_by         UUID         NOT NULL;

-- expires_at was nullable in migration 003; B4 portal links always have an
-- expiry (24h standard, 5-min grace for single_use). Promote to NOT NULL.
-- The unconditional UPDATE handles the empty-table case without a
-- conditional NOW() predicate (which would silently no-op).
UPDATE portal_links SET expires_at = NOW() + INTERVAL '24 hours' WHERE expires_at IS NULL;
ALTER TABLE portal_links ALTER COLUMN expires_at SET NOT NULL;

-- jti uniqueness is the column-level UNIQUE above; Postgres auto-creates
-- the supporting index. Only the secondary lookup index is added here.
CREATE INDEX idx_portal_links_builder_customer_status ON portal_links(builder_id, customer_id, status);

-------------------------------------------------------------------
-- portal_access_grants — OAuth email allowlist (D12)
-------------------------------------------------------------------
CREATE TABLE portal_access_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id   UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'revoked')),
  created_by   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ,
  UNIQUE (builder_id, customer_id, email)
);

CREATE INDEX idx_portal_access_grants_builder_email ON portal_access_grants(builder_id, email);

ALTER TABLE portal_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_access_grants_isolation ON portal_access_grants
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- portal_domains — self-serve custom domain lifecycle (D13, D58)
-------------------------------------------------------------------
CREATE TABLE portal_domains (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id            UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  domain                TEXT NOT NULL UNIQUE,
  verification_token    TEXT NOT NULL,
  dns_status            VARCHAR(40) NOT NULL DEFAULT 'pending_dns'
                          CHECK (dns_status IN ('pending_dns', 'dns_verified', 'failed')),
  certificate_status    VARCHAR(40) NOT NULL DEFAULT 'none'
                          CHECK (certificate_status IN ('none', 'certificate_pending', 'issued', 'failed')),
  domain_status         VARCHAR(40) NOT NULL DEFAULT 'pending_dns'
                          CHECK (domain_status IN (
                            'pending_dns',
                            'dns_verified',
                            'certificate_pending',
                            'active',
                            'failed',
                            'disabled'
                          )),
  certificate_arn       TEXT,
  last_checked_at       TIMESTAMPTZ,
  error_detail          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_portal_domains_status ON portal_domains(domain_status);
-- Builder-scoped index for the dashboard "list my domains" query.
CREATE INDEX idx_portal_domains_builder ON portal_domains(builder_id);

ALTER TABLE portal_domains ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_domains_isolation ON portal_domains
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
