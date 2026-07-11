-- Pylva Portal Schema
-- Migration 003: Customer portal tables with RLS
-- Spec references: Section 3.7

-------------------------------------------------------------------
-- portal_configs: Per-builder portal configuration
-------------------------------------------------------------------
CREATE TABLE portal_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE UNIQUE,
  branding        JSONB NOT NULL DEFAULT '{"logo_url": null, "primary_color": null, "company_name": ""}',
  features        JSONB NOT NULL DEFAULT '{"show_costs": true, "show_traces": false, "show_billing": false}',
  auth_type       VARCHAR(20) NOT NULL DEFAULT 'jwt'
                    CHECK (auth_type IN ('jwt', 'oauth')),
  custom_domain   VARCHAR(255),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE portal_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_configs_isolation ON portal_configs
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- portal_links: Customer portal access links
-------------------------------------------------------------------
CREATE TABLE portal_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type        VARCHAR(20) NOT NULL CHECK (type IN ('jwt', 'oauth')),
  token       TEXT,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_portal_links_builder ON portal_links(builder_id);
CREATE INDEX idx_portal_links_customer ON portal_links(builder_id, customer_id);

ALTER TABLE portal_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY portal_links_isolation ON portal_links
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
