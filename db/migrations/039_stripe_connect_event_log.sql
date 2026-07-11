-- Two-phase webhook idempotency for Stripe Connect billing events.
--
-- The Connect webhook path (/api/v1/billing/webhooks) previously relied on
-- handler-local UPDATE guards. That prevented some status regressions, but it
-- did not dedupe non-status handlers such as charge.dispute.created.
--
-- State model:
--   processing_started_at NOT NULL, handled_at NULL
--     A delivery is currently being processed, or a prior attempt crashed
--     before recording success. Recent duplicates should return non-2xx so
--     Stripe retries; stale rows can be reclaimed.
--   handled_at NOT NULL
--     Handler completed successfully. Exact Stripe redeliveries can be acked
--     without re-dispatch.

CREATE TABLE IF NOT EXISTS stripe_connect_event_log (
  stripe_account_id      TEXT NOT NULL,
  stripe_event_id        TEXT NOT NULL,
  type                   TEXT NOT NULL,
  builder_id             UUID,
  received_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at  TIMESTAMPTZ,
  handled_at             TIMESTAMPTZ,
  last_error             TEXT,
  PRIMARY KEY (stripe_account_id, stripe_event_id)
);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_event_log_received
  ON stripe_connect_event_log(received_at);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_event_log_builder_received
  ON stripe_connect_event_log(builder_id, received_at);

CREATE INDEX IF NOT EXISTS idx_stripe_connect_event_log_unhandled
  ON stripe_connect_event_log(stripe_account_id, stripe_event_id)
  WHERE handled_at IS NULL;
