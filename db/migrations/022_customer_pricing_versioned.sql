-- B2b Phase 0b — Migration 022
-- Versioned customer_pricing. Writes are INSERT-of-new-version + close-prior
-- (set effective_to = NOW()) in the same transaction. Reads for cron/invoice
-- generation use effective_from..effective_to overlap against the billing
-- period so historical invoices remain reproducible (I-T2-10).
--
-- Mid-period pricing change: two active versions cover the period slice;
-- invoice generator auto-splits into two drafts sharing billing_cycle_id (D8).
--
-- Migration strategy: drop the old UNIQUE(builder_id, customer_id); add
-- versioning columns + new pricing-model columns (pack_price_usd,
-- included_credits, overage_rate_usd, markup_pct, base_fee_usd). Backfill
-- existing rows with version=1, effective_from=created_at, effective_to=NULL.
-- Add new UNIQUE(builder_id, customer_id, version) + partial unique to
-- guarantee at most one open version per (builder, customer).
--
-- Per internal design notes (migration 022) + §5.2 I-T2-10 + D5.

ALTER TABLE customer_pricing
  DROP CONSTRAINT customer_pricing_builder_id_customer_id_key;

ALTER TABLE customer_pricing
  ADD COLUMN version          INT NOT NULL DEFAULT 1,
  ADD COLUMN effective_from   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN effective_to     TIMESTAMPTZ,
  ADD COLUMN pack_price_usd   NUMERIC(10,2),
  ADD COLUMN included_credits NUMERIC(18,4),
  ADD COLUMN overage_rate_usd NUMERIC(18,10),
  ADD COLUMN markup_pct       NUMERIC(5,2),
  ADD COLUMN base_fee_usd     NUMERIC(10,2);

-- Backfill effective_from from the original created_at so historical lookups
-- align with the row's actual inception time. Unconditional — this migration
-- runs once; every existing row was just populated with DEFAULT NOW() by ALTER.
UPDATE customer_pricing SET effective_from = created_at;

-- Strict uniqueness on (builder, customer, version).
ALTER TABLE customer_pricing
  ADD CONSTRAINT customer_pricing_builder_customer_version_uk
    UNIQUE (builder_id, customer_id, version);

-- At most one "open" (current) version per (builder, customer).
CREATE UNIQUE INDEX customer_pricing_open_version_uk
  ON customer_pricing (builder_id, customer_id)
  WHERE effective_to IS NULL;

CREATE INDEX idx_customer_pricing_effective ON customer_pricing(builder_id, customer_id, effective_from, effective_to);
