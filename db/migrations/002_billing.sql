-- Pylva Billing Schema
-- Migration 002: Billing tables with RLS
-- Spec references: Section 12 Layer 2, Section 4.4

-------------------------------------------------------------------
-- customer_pricing: Per-customer pricing configuration
-------------------------------------------------------------------
CREATE TABLE customer_pricing (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  pricing_model   VARCHAR(20) NOT NULL
                    CHECK (pricing_model IN ('flat', 'pay_as_you_go', 'credit_pack', 'hybrid')),
  flat_rate_usd   DECIMAL(10,2),
  per_unit_rates  JSONB,                     -- metric -> rate mapping
  credit_balance  DECIMAL(10,2),
  billing_period  VARCHAR(20) NOT NULL DEFAULT 'monthly'
                    CHECK (billing_period IN ('monthly', 'weekly', 'custom')),
  stripe_customer_id VARCHAR(255),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (builder_id, customer_id)
);

CREATE INDEX idx_customer_pricing_builder ON customer_pricing(builder_id);

ALTER TABLE customer_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_pricing_isolation ON customer_pricing
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- invoices: Generated invoices
-------------------------------------------------------------------
CREATE TABLE invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id        UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  stripe_invoice_id VARCHAR(255),
  amount_usd        DECIMAL(10,2) NOT NULL,
  period_start      TIMESTAMPTZ NOT NULL,
  period_end        TIMESTAMPTZ NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'pending', 'paid', 'failed', 'void')),
  line_items        JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoices_builder ON invoices(builder_id);
CREATE INDEX idx_invoices_customer ON invoices(builder_id, customer_id);
CREATE INDEX idx_invoices_status ON invoices(builder_id, status);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_isolation ON invoices
  USING (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- stripe_connect: Builder Stripe Connect state
-------------------------------------------------------------------
CREATE TABLE stripe_connect (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id          UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE UNIQUE,
  stripe_account_id   VARCHAR(255),
  status              VARCHAR(20) NOT NULL DEFAULT 'not_connected'
                        CHECK (status IN ('not_connected', 'pending', 'connected', 'disabled')),
  connected_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stripe_connect ENABLE ROW LEVEL SECURITY;
CREATE POLICY stripe_connect_isolation ON stripe_connect
  USING (builder_id = current_setting('app.builder_id', true)::uuid);
