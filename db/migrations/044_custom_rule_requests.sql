-- Durable inbox for dashboard custom-rule requests.
--
-- The custom-request endpoint accepts a submission before attempting email
-- delivery. This table keeps the request recoverable when Resend is
-- unavailable or only the requester receipt fails.

CREATE TABLE custom_rule_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id              UUID NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  requester_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  requester_email         TEXT NOT NULL,
  requester_display_name  TEXT,
  workspace_name          TEXT,
  workspace_slug          TEXT NOT NULL,
  workspace_email         TEXT NOT NULL,
  workspace_tier          TEXT NOT NULL,
  idea                    TEXT NOT NULL CHECK (char_length(idea) BETWEEN 10 AND 4000),
  email_status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (email_status IN ('pending', 'sent', 'partial_failure', 'failed', 'skipped')),
  internal_email_sent     BOOLEAN NOT NULL DEFAULT false,
  receipt_email_sent      BOOLEAN NOT NULL DEFAULT false,
  last_email_error        TEXT,
  submitted_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_custom_rule_requests_builder_submitted
  ON custom_rule_requests(builder_id, submitted_at DESC);
CREATE INDEX idx_custom_rule_requests_status_submitted
  ON custom_rule_requests(email_status, submitted_at DESC);

ALTER TABLE custom_rule_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY custom_rule_requests_isolation ON custom_rule_requests
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);
