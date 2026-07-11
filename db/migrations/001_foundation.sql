-- Pylva Foundation Schema
-- Migration 001: Core tables with RLS
-- Spec references: Section 4.9 (Security), 4.6 (Storage), 4.10 (API Contract), 4.11 (Pricing)

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-------------------------------------------------------------------
-- builders: Root entity for multi-tenant isolation
-------------------------------------------------------------------
CREATE TABLE builders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       VARCHAR(255) NOT NULL UNIQUE,
  name        VARCHAR(255),
  tier        VARCHAR(20) NOT NULL DEFAULT 'free'
                CHECK (tier IN ('free', 'pro', 'scale', 'enterprise')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE builders ENABLE ROW LEVEL SECURITY;
-- builders RLS uses id (not builder_id) — it IS the root entity
CREATE POLICY builders_isolation ON builders
  USING (id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- customers: Builder's end-user customers
-------------------------------------------------------------------
CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  external_id VARCHAR(255) NOT NULL,  -- Builder's identifier for this customer
  name        VARCHAR(255),
  email       VARCHAR(255),
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (builder_id, external_id)
);

CREATE INDEX idx_customers_builder ON customers(builder_id);

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY customers_isolation ON customers
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- api_keys: SDK authentication
-- Decision #18: Format pv_live_{keyId}_{randomPart}
-- Decision #14: argon2 hashing
-------------------------------------------------------------------
CREATE TABLE api_keys (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      VARCHAR(12) NOT NULL UNIQUE,  -- Short ID for O(1) lookup
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL,                 -- argon2 hash
  scope       VARCHAR(20) NOT NULL CHECK (scope IN ('telemetry', 'vault')),
  label       VARCHAR(100),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_key_id ON api_keys(key_id);
CREATE INDEX idx_api_keys_builder ON api_keys(builder_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_isolation ON api_keys
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- llm_pricing: LLM model pricing table — spec Section 4.11
-------------------------------------------------------------------
CREATE TABLE llm_pricing (
  id              SERIAL PRIMARY KEY,
  provider        VARCHAR(50) NOT NULL,
  model           VARCHAR(100) NOT NULL,
  input_per_1m    DECIMAL(10,4) NOT NULL,   -- USD per 1M input tokens
  output_per_1m   DECIMAL(10,4) NOT NULL,   -- USD per 1M output tokens
  effective_from  TIMESTAMPTZ NOT NULL,
  effective_to    TIMESTAMPTZ,               -- null = currently active
  source          VARCHAR(20) NOT NULL DEFAULT 'admin'
                    CHECK (source IN ('auto', 'admin')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, model, effective_from)
);

CREATE INDEX idx_llm_pricing_lookup ON llm_pricing(provider, model, effective_from);

-- llm_pricing is global (not per-builder), no RLS needed

-------------------------------------------------------------------
-- rules: Reactive rules configuration — spec Section 6
-------------------------------------------------------------------
CREATE TABLE rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL
                CHECK (type IN ('cost_threshold', 'budget_limit', 'model_routing',
                                'reliability_failover', 'margin_protection', 'customer_throttle')),
  enforcement VARCHAR(20) NOT NULL CHECK (enforcement IN ('pre_call', 'post_call')),
  name        VARCHAR(200) NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}',
  customer_id VARCHAR(255),                -- null = applies to all customers
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rules_builder ON rules(builder_id);
CREATE INDEX idx_rules_builder_enabled ON rules(builder_id) WHERE enabled = true;

ALTER TABLE rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY rules_isolation ON rules
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- webhook_configs: Webhook delivery configuration
-------------------------------------------------------------------
CREATE TABLE webhook_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id  UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  events      TEXT[] NOT NULL,              -- Array of event types
  secret      TEXT NOT NULL,                -- HMAC-SHA256 secret
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_configs_builder ON webhook_configs(builder_id);

ALTER TABLE webhook_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_configs_isolation ON webhook_configs
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- webhook_dlq: Dead letter queue for failed webhook deliveries
-------------------------------------------------------------------
CREATE TABLE webhook_dlq (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id        UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  webhook_config_id UUID NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
  event_type        VARCHAR(50) NOT NULL,
  payload           TEXT NOT NULL,           -- JSON string
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_attempt_at   TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_dlq_builder ON webhook_dlq(builder_id);
CREATE INDEX idx_webhook_dlq_pending ON webhook_dlq(attempts) WHERE attempts < 3;

ALTER TABLE webhook_dlq ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_dlq_isolation ON webhook_dlq
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- audit_log: Partitioned audit trail — Decision #20
-- PK is composite (id, timestamp) — required for PG partitioning
-------------------------------------------------------------------
CREATE TABLE audit_log (
  id            BIGSERIAL,
  builder_id    UUID NOT NULL,
  actor_type    VARCHAR(20) NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  actor_id      VARCHAR(255) NOT NULL,
  action        VARCHAR(50) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id   VARCHAR(255),
  details       JSONB,
  ip_address    INET,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, timestamp)
) PARTITION BY RANGE (timestamp);

-- Create initial partitions: current + next month
CREATE TABLE audit_log_y2026m04 PARTITION OF audit_log
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE audit_log_y2026m05 PARTITION OF audit_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE audit_log_y2026m06 PARTITION OF audit_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE INDEX idx_audit_log_builder ON audit_log(builder_id, timestamp);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id, timestamp);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_isolation ON audit_log
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
