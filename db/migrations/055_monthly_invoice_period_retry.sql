-- 055: durable retry ledger for closed monthly invoice periods.
--
-- The monthly invoice cron previously inferred retry eligibility only from
-- wall-clock time near the month boundary. A delayed authoritative projection
-- could therefore outlive that window and permanently skip a billable month.
-- Persist each due (builder, customer, period) until invoice generation
-- succeeds. Deterministic invoice draft keys absorb concurrent or crash retries.

-- Migration 054 moved the referenced billing tables behind a fixed NOLOGIN
-- owner. The migration principal has a non-inheriting SET edge, so create this
-- new general-application table explicitly as that owner. RESET ROLE before
-- the runner records the migration ledger row.
SET ROLE pylva_general_app_runtime;

CREATE TABLE monthly_invoice_periods (
  builder_id      UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (builder_id, customer_id, period_start),
  CONSTRAINT monthly_invoice_periods_status_ck
    CHECK (status IN ('pending', 'completed')),
  CONSTRAINT monthly_invoice_periods_attempts_ck CHECK (attempts >= 0),
  CONSTRAINT monthly_invoice_periods_bounds_ck CHECK (period_start < period_end),
  CONSTRAINT monthly_invoice_periods_completion_ck CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT monthly_invoice_periods_month_bounds_ck CHECK (
    period_start AT TIME ZONE 'UTC' =
      date_trunc('month', period_start AT TIME ZONE 'UTC')
    AND period_end =
      (period_start AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC'
  )
);

CREATE INDEX idx_monthly_invoice_periods_pending
  ON monthly_invoice_periods(period_start)
  WHERE status = 'pending';

ALTER TABLE monthly_invoice_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY monthly_invoice_periods_isolation ON monthly_invoice_periods
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

COMMENT ON TABLE monthly_invoice_periods IS
  'Pending closed monthly billing periods retried until invoice generation succeeds.';

RESET ROLE;
