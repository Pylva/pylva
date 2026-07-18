-- 050: Authoritative all-cost budget-control ledger.
--
-- PostgreSQL is the control and billing authority. Every tenant-owned child
-- relationship carries builder_id, public/per-operation monetary values use
-- exact NUMERIC(38,18), and immutable request/rule/pricing/usage snapshots survive
-- later configuration changes. ClickHouse is populated from the durable
-- outbox and is not consulted to authorize spend.
--
-- This migration is pre-roll and intentionally repeatable. CREATE TABLE IF
-- NOT EXISTS preserves existing ledger data; the physical-contract verifier
-- fails closed if an existing object does not match this definition.

CREATE OR REPLACE FUNCTION pylva_budget_jsonb_sha256(value JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT encode(digest(convert_to(value::TEXT, 'UTF8'), 'sha256'), 'hex')
$$;

CREATE OR REPLACE FUNCTION pylva_budget_decimal_text(value NUMERIC)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN value = 0 THEN '0'
    WHEN strpos(value::TEXT, '.') = 0 THEN value::TEXT
    ELSE regexp_replace(regexp_replace(value::TEXT, '0+$', ''), '[.]$', '')
  END
$$;

CREATE OR REPLACE FUNCTION pylva_budget_jsonb_uuid_matches(
  value JSONB,
  expected UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN expected IS NULL THEN value IS NOT DISTINCT FROM 'null'::JSONB
    WHEN jsonb_typeof(value) IS DISTINCT FROM 'string' THEN FALSE
    ELSE
      (value #>> '{}') ~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      AND lower(value #>> '{}') = expected::TEXT
  END
$$;

CREATE OR REPLACE FUNCTION pylva_budget_uuid_array_is_canonical(value UUID[])
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT array_position(value, NULL) IS NULL
     AND value = ARRAY(
       SELECT DISTINCT item
       FROM unnest(value) AS item
       ORDER BY item
     )
$$;

CREATE OR REPLACE FUNCTION pylva_budget_timestamp_text(value TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT to_char(
    value AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  )
$$;

CREATE OR REPLACE FUNCTION pylva_budget_timestamp_is_wire_safe(value TIMESTAMPTZ)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT value >= '0001-01-01 00:00:00+00'::TIMESTAMPTZ
     AND value < '10000-01-01 00:00:00+00'::TIMESTAMPTZ
$$;

-------------------------------------------------------------------
-- Budget accounts: one protected accumulator per rule/scope/period.
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_accounts (
  builder_id                 UUID NOT NULL REFERENCES builders(id) ON DELETE RESTRICT,
  id                         UUID NOT NULL DEFAULT gen_random_uuid(),
  rule_key                   UUID NOT NULL,
  enforcement                VARCHAR(20) NOT NULL,
  limit_usd                  NUMERIC(38,18) NOT NULL,
  scope                      VARCHAR(20) NOT NULL,
  subject_customer_id        VARCHAR(255),
  period                     VARCHAR(20) NOT NULL,
  period_start               TIMESTAMPTZ NOT NULL,
  period_end                 TIMESTAMPTZ NOT NULL,
  initial_rule_revision_id   UUID NOT NULL,
  initial_rule_snapshot      JSONB NOT NULL,
  initial_rule_snapshot_hash CHAR(64) NOT NULL,
  opening_committed_usd      NUMERIC(38,18) NOT NULL DEFAULT 0,
  committed_usd              NUMERIC NOT NULL DEFAULT 0,
  reserved_usd               NUMERIC(38,18) NOT NULL DEFAULT 0,
  unresolved_usd             NUMERIC(38,18) NOT NULL DEFAULT 0,
  version                    BIGINT NOT NULL DEFAULT 0,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_accounts_pk PRIMARY KEY (builder_id, id),
  CONSTRAINT budget_accounts_rule_identity_uk UNIQUE (builder_id, id, rule_key),
  CONSTRAINT budget_accounts_scope_ck
    CHECK (scope IN ('pooled', 'per_customer')),
  CONSTRAINT budget_accounts_enforcement_ck
    CHECK (enforcement IN ('hard_stop', 'advisory')),
  CONSTRAINT budget_accounts_customer_scope_ck
    CHECK (
      (scope = 'pooled' AND subject_customer_id IS NULL)
      OR
      (scope = 'per_customer'
       AND subject_customer_id IS NOT NULL
       AND subject_customer_id ~ '^[A-Za-z0-9_-]{1,255}$')
    ),
  CONSTRAINT budget_accounts_period_ck
    CHECK (period IN ('hour', 'day', 'week', 'month')),
  CONSTRAINT budget_accounts_period_bounds_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(period_start)
      AND public.pylva_budget_timestamp_is_wire_safe(period_end)
      AND CASE period
        WHEN 'hour' THEN
          period_start AT TIME ZONE 'UTC' = date_trunc('hour', period_start AT TIME ZONE 'UTC')
          AND period_end = period_start + INTERVAL '1 hour'
        WHEN 'day' THEN
          period_start AT TIME ZONE 'UTC' = date_trunc('day', period_start AT TIME ZONE 'UTC')
          AND period_end = period_start + INTERVAL '1 day'
        WHEN 'week' THEN
          period_start AT TIME ZONE 'UTC' = date_trunc('week', period_start AT TIME ZONE 'UTC')
          AND period_end = period_start + INTERVAL '7 days'
        WHEN 'month' THEN
          period_start AT TIME ZONE 'UTC' = date_trunc('month', period_start AT TIME ZONE 'UTC')
          AND period_end = (
            (period_start AT TIME ZONE 'UTC') + INTERVAL '1 month'
          ) AT TIME ZONE 'UTC'
        ELSE FALSE
      END
    ),
  CONSTRAINT budget_accounts_snapshot_ck
    CHECK (
      jsonb_typeof(initial_rule_snapshot) IS NOT DISTINCT FROM 'object'
      AND (initial_rule_snapshot - ARRAY[
        'schema_version', 'rule_key', 'scope', 'subject_customer_id',
        'period', 'period_start', 'period_end', 'enforcement', 'limit_usd',
        'opening_committed_usd'
      ]::TEXT[]) = '{}'::JSONB
      AND jsonb_typeof(initial_rule_snapshot->'schema_version')
        IS NOT DISTINCT FROM 'string'
      AND initial_rule_snapshot->>'schema_version' IS NOT DISTINCT FROM '1.0'
      AND public.pylva_budget_jsonb_uuid_matches(
        initial_rule_snapshot->'rule_key',
        rule_key
      )
      AND initial_rule_snapshot->>'scope' IS NOT DISTINCT FROM scope
      AND (initial_rule_snapshot->'subject_customer_id') IS NOT DISTINCT FROM
        CASE
          WHEN subject_customer_id IS NULL THEN 'null'::JSONB
          ELSE to_jsonb(subject_customer_id)
        END
      AND initial_rule_snapshot->>'period' IS NOT DISTINCT FROM period
      AND initial_rule_snapshot->>'period_start' IS NOT DISTINCT FROM
        public.pylva_budget_timestamp_text(period_start)
      AND initial_rule_snapshot->>'period_end' IS NOT DISTINCT FROM
        public.pylva_budget_timestamp_text(period_end)
      AND initial_rule_snapshot->>'enforcement' IS NOT DISTINCT FROM enforcement
      AND jsonb_typeof(initial_rule_snapshot->'limit_usd')
        IS NOT DISTINCT FROM 'string'
      AND initial_rule_snapshot->>'limit_usd' IS NOT DISTINCT FROM
        public.pylva_budget_decimal_text(limit_usd)
      AND jsonb_typeof(initial_rule_snapshot->'opening_committed_usd')
        IS NOT DISTINCT FROM 'string'
      AND initial_rule_snapshot->>'opening_committed_usd' IS NOT DISTINCT FROM
        public.pylva_budget_decimal_text(opening_committed_usd)
    ),
  CONSTRAINT budget_accounts_snapshot_hash_ck
    CHECK (
      initial_rule_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND initial_rule_snapshot_hash =
        public.pylva_budget_jsonb_sha256(initial_rule_snapshot)
    ),
  CONSTRAINT budget_accounts_amounts_ck
    CHECK (
      committed_usd <> 'NaN'::numeric
      AND committed_usd <> 'Infinity'::numeric
      AND limit_usd <> 'NaN'::numeric
      AND limit_usd >= 0
      AND opening_committed_usd <> 'NaN'::numeric
      AND opening_committed_usd >= 0
      AND reserved_usd <> 'NaN'::numeric
      AND unresolved_usd <> 'NaN'::numeric
      AND committed_usd >= 0
      AND reserved_usd >= 0
      AND unresolved_usd >= 0
      AND committed_usd >= opening_committed_usd
    ),
  CONSTRAINT budget_accounts_timestamps_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND public.pylva_budget_timestamp_is_wire_safe(updated_at)
      AND updated_at >= created_at
    ),
  CONSTRAINT budget_accounts_version_ck
    CHECK (version BETWEEN 0 AND 9223372036854775806),
  CONSTRAINT budget_accounts_natural_identity_uk
    UNIQUE NULLS NOT DISTINCT (
      builder_id,
      rule_key,
      scope,
      subject_customer_id,
      period,
      period_start
    )
);

-------------------------------------------------------------------
-- Immutable builder-wide rule revisions over stable accumulator accounts.
-- One active revision changes a rule atomically for every customer account;
-- editing limit/enforcement never fragments or resets protected spend.
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_rule_revisions (
  builder_id          UUID NOT NULL REFERENCES builders(id) ON DELETE RESTRICT,
  id                  UUID NOT NULL DEFAULT gen_random_uuid(),
  rule_key            UUID NOT NULL,
  revision            BIGINT NOT NULL,
  scope               VARCHAR(20) NOT NULL,
  target_customer_id  VARCHAR(255),
  period              VARCHAR(20) NOT NULL,
  enforcement         VARCHAR(20) NOT NULL,
  limit_usd           NUMERIC(38,18) NOT NULL,
  config_snapshot     JSONB NOT NULL,
  config_snapshot_hash CHAR(64) NOT NULL,
  active_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at          TIMESTAMPTZ,
  retirement_reason   VARCHAR(20),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_rule_revisions_pk PRIMARY KEY (builder_id, id),
  CONSTRAINT budget_rule_revisions_rule_revision_uk
    UNIQUE (builder_id, rule_key, revision),
  CONSTRAINT budget_rule_revisions_allocation_identity_uk
    UNIQUE (builder_id, id, rule_key),
  CONSTRAINT budget_rule_revisions_revision_ck
    CHECK (revision BETWEEN 0 AND 9223372036854775806),
  CONSTRAINT budget_rule_revisions_scope_ck
    CHECK (scope IN ('pooled', 'per_customer')),
  CONSTRAINT budget_rule_revisions_target_ck
    CHECK (
      (scope = 'pooled' AND target_customer_id IS NULL)
      OR (
        scope = 'per_customer'
        AND (
          target_customer_id IS NULL
          OR target_customer_id ~ '^[A-Za-z0-9_-]{1,255}$'
        )
      )
    ),
  CONSTRAINT budget_rule_revisions_period_ck
    CHECK (period IN ('hour', 'day', 'week', 'month')),
  CONSTRAINT budget_rule_revisions_enforcement_ck
    CHECK (enforcement IN ('hard_stop', 'advisory')),
  CONSTRAINT budget_rule_revisions_snapshot_ck
    CHECK (
      jsonb_typeof(config_snapshot) IS NOT DISTINCT FROM 'object'
      AND (config_snapshot - ARRAY[
        'schema_version', 'rule_key', 'scope', 'target_customer_id',
        'period', 'enforcement', 'limit_usd'
      ]::TEXT[]) = '{}'::JSONB
      AND jsonb_typeof(config_snapshot->'schema_version')
        IS NOT DISTINCT FROM 'string'
      AND config_snapshot->>'schema_version' IS NOT DISTINCT FROM '1.0'
      AND public.pylva_budget_jsonb_uuid_matches(
        config_snapshot->'rule_key',
        rule_key
      )
      AND config_snapshot->>'scope' IS NOT DISTINCT FROM scope
      AND config_snapshot->'target_customer_id' IS NOT DISTINCT FROM
        CASE
          WHEN target_customer_id IS NULL THEN 'null'::JSONB
          ELSE to_jsonb(target_customer_id)
        END
      AND config_snapshot->>'period' IS NOT DISTINCT FROM period
      AND config_snapshot->>'enforcement' IS NOT DISTINCT FROM enforcement
      AND jsonb_typeof(config_snapshot->'limit_usd') IS NOT DISTINCT FROM 'string'
      AND config_snapshot->>'limit_usd' IS NOT DISTINCT FROM
        public.pylva_budget_decimal_text(limit_usd)
      AND config_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND config_snapshot_hash = public.pylva_budget_jsonb_sha256(config_snapshot)
    ),
  CONSTRAINT budget_rule_revisions_amount_ck
    CHECK (limit_usd <> 'NaN'::numeric AND limit_usd >= 0),
  CONSTRAINT budget_rule_revisions_lifecycle_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(active_from)
      AND public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND active_from = created_at
      AND (
        (retired_at IS NULL AND retirement_reason IS NULL)
        OR (
          retired_at IS NOT NULL
          AND public.pylva_budget_timestamp_is_wire_safe(retired_at)
          AND retired_at >= active_from
          AND retirement_reason IS NOT NULL
          AND retirement_reason IN ('superseded', 'disabled', 'deleted')
        )
      )
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.budget_accounts'::regclass
      AND conname = 'budget_accounts_initial_rule_revision_fk'
  ) THEN
    ALTER TABLE public.budget_accounts
      ADD CONSTRAINT budget_accounts_initial_rule_revision_fk
      FOREIGN KEY (builder_id, initial_rule_revision_id, rule_key)
      REFERENCES public.budget_rule_revisions(builder_id, id, rule_key)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

-------------------------------------------------------------------
-- Reservations: one immutable reserve decision per operation_id.
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_reservations (
  builder_id               UUID NOT NULL REFERENCES builders(id) ON DELETE RESTRICT,
  decision_id              UUID NOT NULL DEFAULT gen_random_uuid(),
  reservation_id           UUID,
  operation_id             UUID NOT NULL,
  schema_version           VARCHAR(10) NOT NULL,
  request_hash             CHAR(64) NOT NULL,
  request_snapshot         JSONB NOT NULL,
  mode                     VARCHAR(10) NOT NULL,
  kind                     VARCHAR(10) NOT NULL,
  customer_id              VARCHAR(255) NOT NULL,
  trace_id                 UUID NOT NULL,
  span_id                  UUID NOT NULL,
  parent_span_id           UUID,
  step_name                VARCHAR(200),
  framework                VARCHAR(40) NOT NULL DEFAULT 'none',
  reservation_ttl_seconds  INTEGER NOT NULL,

  provider                 VARCHAR(255),
  model                    VARCHAR(255),
  estimated_input_tokens   BIGINT,
  max_output_tokens        BIGINT,

  cost_source_slug         VARCHAR(100),
  tool_name                VARCHAR(200),
  metric                   VARCHAR(100),
  maximum_value            NUMERIC(38,18),

  decision                 VARCHAR(20) NOT NULL,
  decision_reason          VARCHAR(80),
  would_have_denied        BOOLEAN,
  state                    VARCHAR(20),
  pricing_snapshot         JSONB,
  pricing_snapshot_hash    CHAR(64),
  requested_usd            NUMERIC(38,18),
  reserved_usd             NUMERIC(38,18) NOT NULL DEFAULT 0,
  actual_usd               NUMERIC(38,18) NOT NULL DEFAULT 0,
  released_usd             NUMERIC(38,18) NOT NULL DEFAULT 0,
  overage_usd              NUMERIC(38,18) NOT NULL DEFAULT 0,
  remaining_usd            NUMERIC(38,18),
  deciding_account_id      UUID,
  reserve_response_snapshot JSONB NOT NULL,
  rule_revision_ids        UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  rule_set_hash            CHAR(64) NOT NULL DEFAULT repeat('0', 64),
  authorization_transaction_id BIGINT NOT NULL DEFAULT 0,

  expires_at               TIMESTAMPTZ,
  reserved_at              TIMESTAMPTZ,
  refused_at               TIMESTAMPTZ,
  committed_at             TIMESTAMPTZ,
  released_at              TIMESTAMPTZ,
  unresolved_at            TIMESTAMPTZ,
  unresolved_reason        VARCHAR(80),
  state_version            BIGINT NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_reservations_pk PRIMARY KEY (builder_id, decision_id),
  CONSTRAINT budget_reservations_operation_uk UNIQUE (builder_id, operation_id),
  CONSTRAINT budget_reservations_usage_parent_uk
    UNIQUE (builder_id, decision_id, operation_id),
  CONSTRAINT budget_reservations_deciding_account_fk
    FOREIGN KEY (builder_id, deciding_account_id)
    REFERENCES budget_accounts(builder_id, id) ON DELETE RESTRICT,
  CONSTRAINT budget_reservations_schema_version_ck CHECK (schema_version = '1.0'),
  CONSTRAINT budget_reservations_request_hash_ck
    CHECK (
      request_hash ~ '^[0-9a-f]{64}$'
      AND request_hash = public.pylva_budget_jsonb_sha256(request_snapshot)
    ),
  CONSTRAINT budget_reservations_request_snapshot_ck
    CHECK (jsonb_typeof(request_snapshot) = 'object'),
  CONSTRAINT budget_reservations_response_snapshot_ck
    CHECK (jsonb_typeof(reserve_response_snapshot) = 'object'),
  CONSTRAINT budget_reservations_rule_set_ck
    CHECK (
      public.pylva_budget_uuid_array_is_canonical(rule_revision_ids)
      AND rule_set_hash ~ '^[0-9a-f]{64}$'
      AND rule_set_hash =
        public.pylva_budget_jsonb_sha256(to_jsonb(rule_revision_ids))
    ),
  CONSTRAINT budget_reservations_authorization_tx_ck
    CHECK (authorization_transaction_id > 0),
  CONSTRAINT budget_reservations_mode_ck CHECK (mode IN ('shadow', 'enforce')),
  CONSTRAINT budget_reservations_mode_decision_ck
    CHECK (
      (mode = 'shadow' AND decision = 'bypassed')
      OR
      (mode = 'enforce' AND decision IN ('reserved', 'denied', 'bypassed', 'unavailable'))
    ),
  CONSTRAINT budget_reservations_kind_ck CHECK (kind IN ('llm', 'tool')),
  CONSTRAINT budget_reservations_customer_id_ck
    CHECK (customer_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  CONSTRAINT budget_reservations_framework_ck
    CHECK (framework IN (
      'langgraph', 'crewai', 'mastra', 'openai-agents', 'pydantic-ai', 'none'
    )),
  CONSTRAINT budget_reservations_identifiers_ck
    CHECK (
      (step_name IS NULL OR step_name ~ '^[A-Za-z0-9 _.:/-]{0,200}$')
      AND (
        provider IS NULL
        OR (
          char_length(provider) BETWEEN 1 AND 255
          AND provider !~ E'[\\u0001-\\u001F\\u007F]'
          AND provider !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
        )
      )
      AND (
        model IS NULL
        OR (
          char_length(model) BETWEEN 1 AND 255
          AND model !~ E'[\\u0001-\\u001F\\u007F]'
          AND model !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
        )
      )
      AND (
        tool_name IS NULL
        OR (
          char_length(tool_name) BETWEEN 1 AND 200
          AND tool_name ~ '^[A-Za-z0-9 _.:/-]+$'
        )
      )
      AND (
        metric IS NULL
        OR (
          char_length(metric) BETWEEN 1 AND 100
          AND metric !~ E'[\\u0001-\\u001F\\u007F]'
          AND metric !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
        )
      )
    ),
  CONSTRAINT budget_reservations_ttl_ck
    CHECK (reservation_ttl_seconds BETWEEN 30 AND 3600),
  CONSTRAINT budget_reservations_decision_ck
    CHECK (decision IN ('reserved', 'denied', 'bypassed', 'unavailable')),
  CONSTRAINT budget_reservations_state_ck
    CHECK (state IS NULL OR state IN (
      'reserved', 'committed', 'released', 'unresolved', 'refused'
    )),
  CONSTRAINT budget_reservations_usage_shape_ck
    CHECK (
      (
        kind = 'llm'
        AND provider IS NOT NULL
        AND model IS NOT NULL
        AND estimated_input_tokens IS NOT NULL
        AND max_output_tokens IS NOT NULL
        AND cost_source_slug IS NULL
        AND tool_name IS NULL
        AND metric IS NULL
        AND maximum_value IS NULL
      )
      OR
      (
        kind = 'tool'
        AND provider IS NULL
        AND model IS NULL
        AND estimated_input_tokens IS NULL
        AND max_output_tokens IS NULL
        AND cost_source_slug IS NOT NULL
        AND tool_name IS NOT NULL
        AND metric IS NOT NULL
        AND maximum_value IS NOT NULL
      )
    ),
  CONSTRAINT budget_reservations_usage_bounds_ck
    CHECK (
      (estimated_input_tokens IS NULL OR estimated_input_tokens BETWEEN 0 AND 4294967295)
      AND (max_output_tokens IS NULL OR max_output_tokens BETWEEN 0 AND 4294967295)
      AND (maximum_value IS NULL OR maximum_value >= 0)
      AND (cost_source_slug IS NULL OR cost_source_slug ~ '^[a-z0-9][a-z0-9-]{0,99}$')
    ),
  CONSTRAINT budget_reservations_pricing_snapshot_ck
    CHECK (
      (pricing_snapshot IS NULL) = (pricing_snapshot_hash IS NULL)
      AND (pricing_snapshot IS NULL OR jsonb_typeof(pricing_snapshot) = 'object')
      AND (pricing_snapshot_hash IS NULL OR pricing_snapshot_hash ~ '^[0-9a-f]{64}$')
      AND (
        pricing_snapshot IS NULL
        OR pricing_snapshot_hash = public.pylva_budget_jsonb_sha256(pricing_snapshot)
      )
    ),
  CONSTRAINT budget_reservations_amounts_ck
    CHECK (
      (maximum_value IS NULL OR (maximum_value <> 'NaN'::numeric AND maximum_value >= 0))
      AND (requested_usd IS NULL OR (requested_usd <> 'NaN'::numeric AND requested_usd >= 0))
      AND reserved_usd <> 'NaN'::numeric AND reserved_usd >= 0
      AND actual_usd <> 'NaN'::numeric AND actual_usd >= 0
      AND released_usd <> 'NaN'::numeric AND released_usd >= 0
      AND overage_usd <> 'NaN'::numeric AND overage_usd >= 0
      AND (remaining_usd IS NULL OR (remaining_usd <> 'NaN'::numeric AND remaining_usd >= 0))
    ),
  CONSTRAINT budget_reservations_decision_reason_ck
    CHECK (
      CASE decision
        WHEN 'reserved' THEN
          decision_reason IS NULL AND would_have_denied IS NULL
        WHEN 'denied' THEN
          decision_reason IS NOT DISTINCT FROM 'budget_exceeded'
          AND would_have_denied IS NULL
        WHEN 'bypassed' THEN
          CASE decision_reason
            WHEN 'control_disabled' THEN would_have_denied IS NULL
            WHEN 'no_applicable_budget' THEN would_have_denied IS NULL
            WHEN 'shadow_would_allow' THEN mode = 'shadow' AND would_have_denied IS FALSE
            WHEN 'shadow_would_deny' THEN mode = 'shadow' AND would_have_denied IS TRUE
            ELSE FALSE
          END
        WHEN 'unavailable' THEN
          decision_reason IS NOT NULL
          AND decision_reason IN (
            'pricing_unavailable', 'usage_bound_required', 'control_unavailable'
          )
          AND would_have_denied IS NULL
        ELSE FALSE
      END
    ),
  CONSTRAINT budget_reservations_decision_state_ck
    CHECK (
      CASE decision
        WHEN 'reserved' THEN
          reservation_id IS NOT NULL
          AND state IS NOT NULL
          AND state IN ('reserved', 'committed', 'released', 'unresolved')
          AND pricing_snapshot IS NOT NULL
          AND requested_usd IS NOT NULL
          AND reserved_usd = requested_usd
          AND expires_at IS NOT NULL
          AND reserved_at IS NOT NULL
          AND refused_at IS NULL
        WHEN 'denied' THEN
          reservation_id IS NULL
          AND state IS NOT DISTINCT FROM 'refused'
          AND pricing_snapshot IS NOT NULL
          AND requested_usd IS NOT NULL
          AND reserved_usd = 0
          AND expires_at IS NULL
          AND reserved_at IS NULL
          AND refused_at IS NOT NULL
        WHEN 'bypassed' THEN
          reservation_id IS NULL
          AND state IS NULL
          AND (
            decision_reason NOT IN ('shadow_would_allow', 'shadow_would_deny')
            OR (pricing_snapshot IS NOT NULL AND requested_usd IS NOT NULL)
          )
          AND reserved_usd = 0
          AND expires_at IS NULL
          AND reserved_at IS NULL
          AND refused_at IS NULL
        WHEN 'unavailable' THEN
          reservation_id IS NULL
          AND state IS NULL
          AND reserved_usd = 0
          AND expires_at IS NULL
          AND reserved_at IS NULL
          AND refused_at IS NULL
        ELSE FALSE
      END
    ),
  CONSTRAINT budget_reservations_lifecycle_timestamps_ck
    CHECK (
      ((state IS NOT DISTINCT FROM 'committed') = (committed_at IS NOT NULL))
      AND ((state IS NOT DISTINCT FROM 'released') = (released_at IS NOT NULL))
      AND ((state IS NOT DISTINCT FROM 'unresolved') = (unresolved_at IS NOT NULL))
      AND ((state IS NOT DISTINCT FROM 'refused') = (refused_at IS NOT NULL))
      AND (unresolved_at IS NULL) = (unresolved_reason IS NULL)
      AND (unresolved_reason IS NULL OR unresolved_reason = 'lease_expired')
      AND (reserved_at IS NULL OR expires_at > reserved_at)
      AND (expires_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(expires_at))
      AND (reserved_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(reserved_at))
      AND (refused_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(refused_at))
      AND (committed_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(committed_at))
      AND (released_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(released_at))
      AND (unresolved_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(unresolved_at))
      AND public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND public.pylva_budget_timestamp_is_wire_safe(updated_at)
      AND updated_at >= created_at
      AND (reserved_at IS NULL OR reserved_at >= created_at)
      AND (refused_at IS NULL OR refused_at >= created_at)
      AND (committed_at IS NULL OR committed_at >= reserved_at)
      AND (released_at IS NULL OR released_at >= reserved_at)
      AND (unresolved_at IS NULL OR unresolved_at >= reserved_at)
    ),
  CONSTRAINT budget_reservations_settlement_math_ck
    CHECK (
      (
        state = 'committed'
        AND released_usd = GREATEST(reserved_usd - actual_usd, 0)
        AND overage_usd = GREATEST(actual_usd - reserved_usd, 0)
      )
      OR
      (
        state = 'released'
        AND actual_usd = 0
        AND released_usd = reserved_usd
        AND overage_usd = 0
      )
      OR
      (
        (state IS NULL OR state IN ('reserved', 'unresolved', 'refused'))
        AND actual_usd = 0
        AND released_usd = 0
        AND overage_usd = 0
      )
    ),
  CONSTRAINT budget_reservations_state_version_ck
    CHECK (state_version BETWEEN 0 AND 9223372036854775806)
);

-------------------------------------------------------------------
-- Allocations: a reservation's decision against every applicable account.
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_reservation_allocations (
  builder_id             UUID NOT NULL,
  id                     UUID NOT NULL DEFAULT gen_random_uuid(),
  reservation_decision_id UUID NOT NULL,
  account_id             UUID NOT NULL,
  rule_key               UUID NOT NULL,
  rule_revision_id       UUID NOT NULL,
  rule_snapshot          JSONB NOT NULL,
  rule_snapshot_hash     CHAR(64) NOT NULL,
  enforcement            VARCHAR(20) NOT NULL,
  evaluation_order       INTEGER NOT NULL,
  is_deciding            BOOLEAN NOT NULL DEFAULT FALSE,
  account_version_before BIGINT NOT NULL,
  held_at_reserve        BOOLEAN NOT NULL,
  status                 VARCHAR(30) NOT NULL,
  committed_before_usd   NUMERIC(38,18) NOT NULL,
  reserved_before_usd    NUMERIC(38,18) NOT NULL,
  unresolved_before_usd  NUMERIC(38,18) NOT NULL,
  requested_usd          NUMERIC(38,18) NOT NULL,
  projected_usd          NUMERIC(38,18) NOT NULL,
  limit_usd              NUMERIC(38,18) NOT NULL,
  remaining_usd          NUMERIC(38,18) NOT NULL,
  authorized_usd         NUMERIC(38,18) NOT NULL DEFAULT 0,
  actual_usd             NUMERIC(38,18) NOT NULL DEFAULT 0,
  released_usd           NUMERIC(38,18) NOT NULL DEFAULT 0,
  unresolved_usd         NUMERIC(38,18) NOT NULL DEFAULT 0,
  overage_usd            NUMERIC(38,18) NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_reservation_allocations_pk PRIMARY KEY (builder_id, id),
  CONSTRAINT budget_reservation_allocations_account_uk
    UNIQUE (builder_id, reservation_decision_id, account_id),
  CONSTRAINT budget_reservation_allocations_rule_uk
    UNIQUE (builder_id, reservation_decision_id, rule_key),
  CONSTRAINT budget_reservation_allocations_order_uk
    UNIQUE (builder_id, reservation_decision_id, evaluation_order),
  CONSTRAINT budget_reservation_allocations_reservation_fk
    FOREIGN KEY (builder_id, reservation_decision_id)
    REFERENCES budget_reservations(builder_id, decision_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_reservation_allocations_account_fk
    FOREIGN KEY (builder_id, account_id, rule_key)
    REFERENCES budget_accounts(builder_id, id, rule_key) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_reservation_allocations_rule_revision_fk
    FOREIGN KEY (builder_id, rule_revision_id, rule_key)
    REFERENCES budget_rule_revisions(builder_id, id, rule_key)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_reservation_allocations_snapshot_ck
    CHECK (
      jsonb_typeof(rule_snapshot) = 'object'
      AND rule_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND rule_snapshot_hash = public.pylva_budget_jsonb_sha256(rule_snapshot)
    ),
  CONSTRAINT budget_reservation_allocations_enforcement_ck
    CHECK (enforcement IN ('hard_stop', 'advisory')),
  CONSTRAINT budget_reservation_allocations_status_ck
    CHECK (status IN (
      'reserved', 'refused', 'not_held', 'shadow',
      'committed', 'released', 'unresolved'
    )),
  CONSTRAINT budget_reservation_allocations_deciding_ck
    CHECK (
      NOT is_deciding
      OR (
        enforcement = 'hard_stop'
        AND status IN ('refused', 'shadow')
        AND projected_usd > limit_usd
      )
    ),
  CONSTRAINT budget_reservation_allocations_order_ck CHECK (evaluation_order >= 0),
  CONSTRAINT budget_reservation_allocations_account_version_ck
    CHECK (account_version_before BETWEEN 0 AND 9223372036854775806),
  CONSTRAINT budget_reservation_allocations_held_ck
    CHECK (
      held_at_reserve =
        (status IN ('reserved', 'committed', 'released', 'unresolved'))
    ),
  CONSTRAINT budget_reservation_allocations_decision_math_ck
    CHECK (
      committed_before_usd <> 'NaN'::numeric AND committed_before_usd >= 0
      AND reserved_before_usd <> 'NaN'::numeric AND reserved_before_usd >= 0
      AND unresolved_before_usd <> 'NaN'::numeric AND unresolved_before_usd >= 0
      AND requested_usd <> 'NaN'::numeric AND requested_usd >= 0
      AND projected_usd <> 'NaN'::numeric
      AND projected_usd =
        committed_before_usd + reserved_before_usd + unresolved_before_usd + requested_usd
      AND limit_usd <> 'NaN'::numeric AND limit_usd >= 0
      AND remaining_usd <> 'NaN'::numeric
      AND remaining_usd = CASE
        WHEN projected_usd <= limit_usd THEN limit_usd - projected_usd
        ELSE GREATEST(
          limit_usd - committed_before_usd - reserved_before_usd - unresolved_before_usd,
          0
        )
      END
    ),
  CONSTRAINT budget_reservation_allocations_authorization_ck
    CHECK (
      (status IN ('reserved', 'committed', 'released', 'unresolved')
       AND authorized_usd = requested_usd)
      OR
      (status IN ('refused', 'not_held', 'shadow') AND authorized_usd = 0)
    ),
  CONSTRAINT budget_reservation_allocations_amounts_ck
    CHECK (
      authorized_usd <> 'NaN'::numeric AND authorized_usd >= 0
      AND actual_usd <> 'NaN'::numeric AND actual_usd >= 0
      AND released_usd <> 'NaN'::numeric AND released_usd >= 0
      AND unresolved_usd <> 'NaN'::numeric AND unresolved_usd >= 0
      AND overage_usd <> 'NaN'::numeric AND overage_usd >= 0
    ),
  CONSTRAINT budget_reservation_allocations_control_result_ck
    CHECK (
      (status = 'refused'
       AND enforcement = 'hard_stop'
       AND projected_usd > limit_usd)
      OR
      status = 'not_held'
      OR
      (status IN ('reserved', 'committed', 'released', 'unresolved')
       AND (enforcement = 'advisory' OR projected_usd <= limit_usd))
      OR
      status = 'shadow'
    ),
  CONSTRAINT budget_reservation_allocations_settlement_math_ck
    CHECK (
      (
        status = 'committed'
        AND released_usd = GREATEST(authorized_usd - actual_usd, 0)
        AND overage_usd = GREATEST(actual_usd - authorized_usd, 0)
        AND unresolved_usd = 0
      )
      OR
      (
        status = 'released'
        AND actual_usd = 0
        AND released_usd = authorized_usd
        AND unresolved_usd = 0
        AND overage_usd = 0
      )
      OR
      (
        status = 'unresolved'
        AND actual_usd = 0
        AND released_usd = 0
        AND unresolved_usd = authorized_usd
        AND overage_usd = 0
      )
      OR
      (
        status IN ('reserved', 'refused', 'not_held', 'shadow')
        AND actual_usd = 0
        AND released_usd = 0
        AND unresolved_usd = 0
        AND overage_usd = 0
      )
    ),
  CONSTRAINT budget_reservation_allocations_timestamps_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND public.pylva_budget_timestamp_is_wire_safe(updated_at)
      AND updated_at >= created_at
    )
);

-------------------------------------------------------------------
-- Lifecycle transitions: immutable audit and idempotency records.
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_reservation_transitions (
  builder_id               UUID NOT NULL,
  id                       UUID NOT NULL DEFAULT gen_random_uuid(),
  reservation_decision_id  UUID NOT NULL,
  type                     VARCHAR(30) NOT NULL,
  extension_id             UUID,
  release_reason           VARCHAR(50),
  request_hash             CHAR(64) NOT NULL,
  request_snapshot         JSONB NOT NULL,
  response_snapshot        JSONB NOT NULL,
  from_state               VARCHAR(20) NOT NULL,
  to_state                 VARCHAR(20) NOT NULL,
  from_state_version       BIGINT NOT NULL,
  to_state_version         BIGINT NOT NULL,
  from_expires_at          TIMESTAMPTZ NOT NULL,
  to_expires_at            TIMESTAMPTZ NOT NULL,
  extend_by_seconds        INTEGER,
  occurred_at              TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),

  CONSTRAINT budget_reservation_transitions_pk PRIMARY KEY (builder_id, id),
  CONSTRAINT budget_reservation_transitions_reservation_fk
    FOREIGN KEY (builder_id, reservation_decision_id)
    REFERENCES budget_reservations(builder_id, decision_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_reservation_transitions_type_ck
    CHECK (type IN ('commit', 'release', 'extend', 'expire_unresolved')),
  CONSTRAINT budget_reservation_transitions_extension_ck
    CHECK (
      (type = 'extend') = (extension_id IS NOT NULL)
      AND (type = 'extend') = (extend_by_seconds IS NOT NULL)
    ),
  CONSTRAINT budget_reservation_transitions_release_reason_ck
    CHECK (
      (type = 'release') = (release_reason IS NOT NULL)
      AND (
        release_reason IS NULL
        OR release_reason IN (
          'provider_not_called', 'provider_confirmed_uncharged'
        )
      )
    ),
  CONSTRAINT budget_reservation_transitions_snapshot_ck
    CHECK (
      request_hash ~ '^[0-9a-f]{64}$'
      AND request_hash = public.pylva_budget_jsonb_sha256(request_snapshot)
      AND jsonb_typeof(request_snapshot) = 'object'
      AND jsonb_typeof(response_snapshot) = 'object'
    ),
  CONSTRAINT budget_reservation_transitions_state_ck
    CHECK (
      (type = 'commit'
       AND from_state IN ('reserved', 'unresolved')
       AND to_state = 'committed')
      OR
      (type = 'release'
       AND from_state IN ('reserved', 'unresolved')
       AND to_state = 'released')
      OR
      (type = 'extend' AND from_state = 'reserved' AND to_state = 'reserved')
      OR
      (type = 'expire_unresolved'
       AND from_state = 'reserved'
       AND to_state = 'unresolved')
    ),
  CONSTRAINT budget_reservation_transitions_version_ck
    CHECK (
      from_state_version BETWEEN 0 AND 9223372036854775806
      AND to_state_version BETWEEN 1 AND 9223372036854775807
      AND to_state_version - from_state_version = 1
    ),
  CONSTRAINT budget_reservation_transitions_expiry_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(from_expires_at)
      AND public.pylva_budget_timestamp_is_wire_safe(to_expires_at)
      AND public.pylva_budget_timestamp_is_wire_safe(occurred_at)
      AND (
        (
          type = 'extend'
          AND extend_by_seconds BETWEEN 30 AND 3600
          AND to_expires_at =
            from_expires_at + make_interval(secs => extend_by_seconds)
          AND occurred_at < from_expires_at
        )
        OR
        (
          type = 'expire_unresolved'
          AND extend_by_seconds IS NULL
          AND to_expires_at = from_expires_at
          AND occurred_at >= from_expires_at
        )
        OR
        (
          type IN ('commit', 'release')
          AND extend_by_seconds IS NULL
          AND to_expires_at = from_expires_at
          AND (from_state = 'unresolved' OR occurred_at < from_expires_at)
        )
      )
    )
);

-- A refusal points at an allocation from the same decision, not merely at any
-- account owned by the tenant. The cycle is intentionally deferred so either
-- the reservation or allocation statement may execute first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'budget_reservations_deciding_allocation_fk'
      AND conrelid = 'public.budget_reservations'::regclass
  ) THEN
    ALTER TABLE public.budget_reservations
      ADD CONSTRAINT budget_reservations_deciding_allocation_fk
      FOREIGN KEY (builder_id, decision_id, deciding_account_id)
      REFERENCES public.budget_reservation_allocations(
        builder_id, reservation_decision_id, account_id
      )
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

-------------------------------------------------------------------
-- Short-retention authoritative usage ledger (one row per commit).
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_usage_ledger (
  builder_id               UUID NOT NULL,
  id                       UUID NOT NULL DEFAULT gen_random_uuid(),
  reservation_decision_id  UUID NOT NULL,
  operation_id             UUID NOT NULL,
  cost_event_id            UUID NOT NULL,
  customer_id              VARCHAR(255) NOT NULL,
  trace_id                 UUID NOT NULL,
  span_id                  UUID NOT NULL,
  parent_span_id           UUID,
  step_name                VARCHAR(200),
  framework                VARCHAR(40) NOT NULL DEFAULT 'none',
  sdk_version              VARCHAR(50) NOT NULL DEFAULT 'unknown',
  sdk_language             VARCHAR(20) NOT NULL DEFAULT 'unknown',
  kind                     VARCHAR(10) NOT NULL,

  provider                 VARCHAR(255),
  model                    VARCHAR(255),
  actual_input_tokens      BIGINT,
  actual_output_tokens     BIGINT,

  cost_source_slug         VARCHAR(100),
  tool_name                VARCHAR(200),
  metric                   VARCHAR(100),
  actual_value             NUMERIC(38,18),

  status                   VARCHAR(20) NOT NULL,
  latency_ms               BIGINT NOT NULL,
  stream_aborted           BOOLEAN NOT NULL,
  actual_cost_usd          NUMERIC(38,18) NOT NULL,
  pricing_snapshot         JSONB,
  pricing_snapshot_hash    CHAR(64) NOT NULL,
  usage_snapshot           JSONB,
  usage_snapshot_hash      CHAR(64) NOT NULL,
  cost_source              VARCHAR(20) NOT NULL,
  instrumentation_tier     VARCHAR(20) NOT NULL,
  is_demo                  BOOLEAN NOT NULL DEFAULT FALSE,
  retention_days           INTEGER NOT NULL,
  billing_retention_days   INTEGER NOT NULL,
  metadata                 JSONB DEFAULT '{}'::jsonb,
  committed_at             TIMESTAMPTZ NOT NULL,
  retain_until             TIMESTAMPTZ NOT NULL,
  details_purged_at        TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),

  CONSTRAINT budget_usage_ledger_pk PRIMARY KEY (builder_id, id),
  CONSTRAINT budget_usage_ledger_reservation_fk
    FOREIGN KEY (builder_id, reservation_decision_id, operation_id)
    REFERENCES budget_reservations(builder_id, decision_id, operation_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_usage_ledger_decision_uk
    UNIQUE (builder_id, reservation_decision_id),
  CONSTRAINT budget_usage_ledger_operation_uk UNIQUE (builder_id, operation_id),
  CONSTRAINT budget_usage_ledger_cost_event_uk UNIQUE (builder_id, cost_event_id),
  CONSTRAINT budget_usage_ledger_outbox_parent_uk
    UNIQUE (builder_id, id, cost_event_id),
  CONSTRAINT budget_usage_ledger_customer_id_ck
    CHECK (customer_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  CONSTRAINT budget_usage_ledger_framework_ck
    CHECK (framework IN (
      'langgraph', 'crewai', 'mastra', 'openai-agents', 'pydantic-ai', 'none'
    )),
  CONSTRAINT budget_usage_ledger_sdk_identity_ck
    CHECK (
      sdk_language IN ('python', 'typescript', 'unknown')
      AND sdk_version ~ '^[ -~]{1,50}$'
    ),
  CONSTRAINT budget_usage_ledger_identifiers_ck
    CHECK (
      (step_name IS NULL OR step_name ~ '^[A-Za-z0-9 _.:/-]{0,200}$')
      AND (
        provider IS NULL
        OR (
          char_length(provider) BETWEEN 1 AND 255
          AND provider !~ E'[\\u0001-\\u001F\\u007F]'
          AND provider !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
        )
      )
      AND (
        model IS NULL
        OR (
          char_length(model) BETWEEN 1 AND 255
          AND model !~ E'[\\u0001-\\u001F\\u007F]'
          AND model !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
        )
      )
      AND (
        tool_name IS NULL
        OR (
          char_length(tool_name) BETWEEN 1 AND 200
          AND tool_name ~ '^[A-Za-z0-9 _.:/-]+$'
        )
      )
      AND (
        metric IS NULL
        OR (
          char_length(metric) BETWEEN 1 AND 100
          AND metric !~ E'[\\u0001-\\u001F\\u007F]'
          AND metric !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
        )
      )
    ),
  CONSTRAINT budget_usage_ledger_kind_ck CHECK (kind IN ('llm', 'tool')),
  CONSTRAINT budget_usage_ledger_usage_shape_ck
    CHECK (
      (
        kind = 'llm'
        AND provider IS NOT NULL
        AND model IS NOT NULL
        AND actual_input_tokens IS NOT NULL
        AND actual_output_tokens IS NOT NULL
        AND cost_source_slug IS NULL
        AND tool_name IS NULL
        AND metric IS NULL
        AND actual_value IS NULL
      )
      OR
      (
        kind = 'tool'
        AND provider IS NULL
        AND model IS NULL
        AND actual_input_tokens IS NULL
        AND actual_output_tokens IS NULL
        AND cost_source_slug IS NOT NULL
        AND tool_name IS NOT NULL
        AND metric IS NOT NULL
        AND actual_value IS NOT NULL
      )
    ),
  CONSTRAINT budget_usage_ledger_usage_bounds_ck
    CHECK (
      (actual_input_tokens IS NULL OR actual_input_tokens BETWEEN 0 AND 4294967295)
      AND (actual_output_tokens IS NULL OR actual_output_tokens BETWEEN 0 AND 4294967295)
      AND (actual_value IS NULL OR (actual_value <> 'NaN'::numeric AND actual_value >= 0))
      AND latency_ms BETWEEN 0 AND 4294967295
      AND actual_cost_usd <> 'NaN'::numeric
      AND actual_cost_usd >= 0
      AND (cost_source_slug IS NULL OR cost_source_slug ~ '^[a-z0-9][a-z0-9-]{0,99}$')
    ),
  CONSTRAINT budget_usage_ledger_status_ck
    CHECK (status IN ('success', 'failure', 'retry', 'aborted')),
  CONSTRAINT budget_usage_ledger_projection_shape_ck
    CHECK (
      cost_source IN ('auto', 'configured')
      AND instrumentation_tier IN ('sdk_wrapper', 'reported')
      AND (
        (kind = 'llm' AND instrumentation_tier = 'sdk_wrapper')
        OR
        (kind = 'tool'
         AND instrumentation_tier = 'reported'
         AND cost_source = 'configured')
      )
    ),
  CONSTRAINT budget_usage_ledger_snapshots_ck
    CHECK (
      pricing_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND usage_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND CASE
        WHEN details_purged_at IS NULL THEN
          pricing_snapshot IS NOT NULL
          AND jsonb_typeof(pricing_snapshot) = 'object'
          AND pricing_snapshot_hash =
            public.pylva_budget_jsonb_sha256(pricing_snapshot)
          AND usage_snapshot IS NOT NULL
          AND jsonb_typeof(usage_snapshot) = 'object'
          AND usage_snapshot_hash =
            public.pylva_budget_jsonb_sha256(usage_snapshot)
        ELSE
          pricing_snapshot IS NULL
          AND usage_snapshot IS NULL
          AND metadata IS NULL
          AND public.pylva_budget_timestamp_is_wire_safe(details_purged_at)
          AND details_purged_at >= retain_until
      END
    ),
  CONSTRAINT budget_usage_ledger_metadata_ck
    CHECK (
      CASE
        WHEN details_purged_at IS NULL THEN
          metadata IS NOT NULL
          AND jsonb_typeof(metadata) = 'object'
          AND (metadata - ARRAY[
            'provider_request_id', 'token_count_source', 'finish_reason'
          ]::text[]) = '{}'::jsonb
          AND (
            metadata->'provider_request_id' IS NULL
            OR (
              jsonb_typeof(metadata->'provider_request_id') = 'string'
              AND char_length(metadata->>'provider_request_id') <= 255
              AND metadata->>'provider_request_id' !~ E'[\\u0001-\\u001F\\u007F]'
            )
          )
          AND (
            metadata->'token_count_source' IS NULL
            OR (
              jsonb_typeof(metadata->'token_count_source') = 'string'
              AND metadata->>'token_count_source' IN ('exact', 'estimated')
            )
          )
          AND (
            metadata->'finish_reason' IS NULL
            OR (
              jsonb_typeof(metadata->'finish_reason') = 'string'
              AND char_length(metadata->>'finish_reason') <= 100
              AND metadata->>'finish_reason' !~ E'[\\u0001-\\u001F\\u007F]'
            )
          )
        ELSE metadata IS NULL
      END
    ),
  CONSTRAINT budget_usage_ledger_retention_ck
    CHECK (
      retention_days BETWEEN 1 AND 18250
      AND billing_retention_days BETWEEN retention_days AND 18250
      AND public.pylva_budget_timestamp_is_wire_safe(committed_at)
      AND public.pylva_budget_timestamp_is_wire_safe(retain_until)
      AND public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND created_at >= committed_at
      AND retain_until >= committed_at + billing_retention_days * INTERVAL '1 day'
    )
);

-------------------------------------------------------------------
-- Durable projection outbox. Failed rows are retried; never dead-lettered.
-------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS budget_cost_event_outbox (
  builder_id             UUID NOT NULL,
  id                     UUID NOT NULL DEFAULT gen_random_uuid(),
  usage_ledger_id        UUID NOT NULL,
  cost_event_id          UUID NOT NULL,
  payload_schema_version VARCHAR(10) NOT NULL,
  payload                JSONB,
  payload_hash           CHAR(64) NOT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts               INTEGER NOT NULL DEFAULT 0,
  available_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at              TIMESTAMPTZ,
  lock_expires_at        TIMESTAMPTZ,
  lock_owner             VARCHAR(100),
  last_attempt_at        TIMESTAMPTZ,
  projected_at           TIMESTAMPTZ,
  projection_verified_at TIMESTAMPTZ,
  payload_purged_at      TIMESTAMPTZ,
  last_error_code        VARCHAR(80),
  last_error_message     VARCHAR(1000),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_cost_event_outbox_pk PRIMARY KEY (builder_id, id),
  CONSTRAINT budget_cost_event_outbox_usage_fk
    FOREIGN KEY (builder_id, usage_ledger_id, cost_event_id)
    REFERENCES budget_usage_ledger(builder_id, id, cost_event_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_cost_event_outbox_usage_uk UNIQUE (builder_id, usage_ledger_id),
  CONSTRAINT budget_cost_event_outbox_event_uk UNIQUE (builder_id, cost_event_id),
  CONSTRAINT budget_cost_event_outbox_payload_ck
    CHECK (
      payload_schema_version = '1.6'
      AND payload_hash ~ '^[0-9a-f]{64}$'
      AND CASE
        WHEN payload_purged_at IS NULL THEN
          payload IS NOT NULL
          AND jsonb_typeof(payload) IS NOT DISTINCT FROM 'object'
          AND payload_hash = public.pylva_budget_jsonb_sha256(payload)
          AND jsonb_typeof(payload->'event_id') IS NOT DISTINCT FROM 'string'
          AND payload->>'event_id' IS NOT DISTINCT FROM cost_event_id::text
          AND jsonb_typeof(payload->'builder_id') IS NOT DISTINCT FROM 'string'
          AND payload->>'builder_id' IS NOT DISTINCT FROM builder_id::text
        ELSE
          payload IS NULL
          AND status = 'projected'
          AND projection_verified_at IS NOT NULL
          AND public.pylva_budget_timestamp_is_wire_safe(payload_purged_at)
          AND payload_purged_at >= projection_verified_at
          AND payload_purged_at >= projected_at
      END
    ),
  CONSTRAINT budget_cost_event_outbox_status_ck
    CHECK (status IN ('pending', 'processing', 'projected')),
  CONSTRAINT budget_cost_event_outbox_attempts_ck
    CHECK (attempts BETWEEN 0 AND 2147483646),
  CONSTRAINT budget_cost_event_outbox_error_ck
    CHECK (
      (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,80}$')
      AND (
        last_error_message IS NULL
        OR last_error_message !~ E'[\\u0001-\\u001F\\u007F]'
      )
    ),
  CONSTRAINT budget_cost_event_outbox_lifecycle_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(available_at)
      AND public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND public.pylva_budget_timestamp_is_wire_safe(updated_at)
      AND available_at >= created_at
      AND (locked_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(locked_at))
      AND (lock_expires_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(lock_expires_at))
      AND (last_attempt_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(last_attempt_at))
      AND (projected_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(projected_at))
      AND (projection_verified_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(projection_verified_at))
      AND (payload_purged_at IS NULL OR public.pylva_budget_timestamp_is_wire_safe(payload_purged_at))
      AND (
        projection_verified_at IS NULL
        OR (
          status = 'projected'
          AND projected_at IS NOT NULL
          AND projection_verified_at >= projected_at
        )
      )
      AND
      (
        (
          status = 'pending'
          AND locked_at IS NULL
          AND lock_expires_at IS NULL
          AND lock_owner IS NULL
          AND projected_at IS NULL
        )
        OR
        (
          status = 'processing'
          AND locked_at IS NOT NULL
          AND lock_expires_at IS NOT NULL
          AND lock_expires_at > locked_at
          AND lock_expires_at <= locked_at + INTERVAL '5 minutes'
          AND lock_owner IS NOT NULL
          AND char_length(lock_owner) BETWEEN 1 AND 100
          AND lock_owner !~ E'[\\u0001-\\u001F\\u007F]'
          AND lock_owner !~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
          AND attempts > 0
          AND last_attempt_at IS NOT NULL
          AND last_attempt_at >= locked_at
          AND projected_at IS NULL
        )
        OR
        (
          status = 'projected'
          AND locked_at IS NULL
          AND lock_expires_at IS NULL
          AND lock_owner IS NULL
          AND projected_at IS NOT NULL
          AND attempts > 0
          AND last_attempt_at IS NOT NULL
          AND projected_at >= last_attempt_at
        )
      )
    ),
  CONSTRAINT budget_cost_event_outbox_attempt_time_ck
    CHECK (
      (attempts = 0 AND last_attempt_at IS NULL)
      OR (
        attempts > 0
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at >= created_at
      )
    )
);

-- The outbox is a deterministic projection of authoritative usage, never a
-- second client-authored account of cost. JSONB supplies stable key ordering;
-- exact decimal values stay strings until the ClickHouse projector casts them.
CREATE OR REPLACE FUNCTION pylva_budget_cost_event_payload(
  usage_row public.budget_usage_ledger
)
RETURNS JSONB
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'schema_version', '1.6',
    'event_id', usage_row.cost_event_id::TEXT,
    'timestamp', to_char(
      usage_row.committed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'builder_id', usage_row.builder_id::TEXT,
    'reservation_decision_id', usage_row.reservation_decision_id::TEXT,
    'operation_id', usage_row.operation_id::TEXT,
    'trace_id', usage_row.trace_id::TEXT,
    'span_id', usage_row.span_id::TEXT,
    'parent_span_id', usage_row.parent_span_id::TEXT,
    'customer_id', usage_row.builder_id::TEXT || ':' || usage_row.customer_id,
    'provider', COALESCE(usage_row.provider, 'other'),
    'model', usage_row.model,
    'operation', CASE
      WHEN usage_row.instrumentation_tier = 'reported' THEN 'reported'
      WHEN usage_row.kind = 'tool' THEN 'tool_call'
      ELSE 'chat.completions'
    END,
    'step_name', usage_row.step_name,
    'tokens_in', COALESCE(usage_row.actual_input_tokens, 0),
    'tokens_out', COALESCE(usage_row.actual_output_tokens, 0),
    'cost_usd', public.pylva_budget_decimal_text(usage_row.actual_cost_usd),
    'pricing_status', 'priced',
    'latency_ms', usage_row.latency_ms,
    'status', usage_row.status,
    'cost_source', usage_row.cost_source,
    'instrumentation_tier', usage_row.instrumentation_tier,
    'metric', usage_row.metric,
    'metric_value', CASE
      WHEN usage_row.actual_value IS NULL THEN NULL
      ELSE public.pylva_budget_decimal_text(usage_row.actual_value)
    END,
    'stream_aborted', usage_row.stream_aborted,
    'abort_savings', '0',
    'is_demo', usage_row.is_demo,
    'retention_days', usage_row.retention_days,
    'billing_retention_days', usage_row.billing_retention_days,
    'metadata', jsonb_strip_nulls(
      usage_row.metadata || jsonb_build_object(
        'sdk_version', usage_row.sdk_version,
        'sdk_language', usage_row.sdk_language,
        'framework', usage_row.framework,
        'tool_name', usage_row.tool_name,
        'cost_source_slug', usage_row.cost_source_slug,
        'pricing_snapshot_hash', usage_row.pricing_snapshot_hash,
        'usage_snapshot_hash', usage_row.usage_snapshot_hash
      )
    )
  )
$$;

CREATE OR REPLACE FUNCTION pylva_budget_assert_reservation_snapshots(
  tenant_id UUID,
  reservation_decision UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  account_row public.budget_accounts%ROWTYPE;
  allocation_row public.budget_reservation_allocations%ROWTYPE;
  parent public.budget_reservations%ROWTYPE;
  request_body JSONB;
  response_body JSONB;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match snapshot tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO parent
  FROM public.budget_reservations
  WHERE builder_id = tenant_id
    AND decision_id = reservation_decision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'snapshot validation has no matching reservation'
      USING ERRCODE = '23503';
  END IF;

  request_body := parent.request_snapshot;
  response_body := parent.reserve_response_snapshot;

  IF jsonb_typeof(request_body->'schema_version') IS DISTINCT FROM 'string'
     OR request_body->>'schema_version' IS DISTINCT FROM parent.schema_version
     OR request_body->>'mode' IS DISTINCT FROM parent.mode
     OR NOT public.pylva_budget_jsonb_uuid_matches(
       request_body->'operation_id', parent.operation_id
     )
     OR jsonb_typeof(request_body->'customer_id') IS DISTINCT FROM 'string'
     OR request_body->>'customer_id' IS DISTINCT FROM parent.customer_id
     OR NOT public.pylva_budget_jsonb_uuid_matches(
       request_body->'trace_id', parent.trace_id
     )
     OR NOT public.pylva_budget_jsonb_uuid_matches(
       request_body->'span_id', parent.span_id
     )
     OR NOT (request_body ? 'parent_span_id')
     OR NOT public.pylva_budget_jsonb_uuid_matches(
       request_body->'parent_span_id', parent.parent_span_id
     )
     OR NOT (request_body ? 'step_name')
     OR jsonb_typeof(request_body->'step_name') IS DISTINCT FROM
       (CASE WHEN parent.step_name IS NULL THEN 'null' ELSE 'string' END)
     OR request_body->>'step_name' IS DISTINCT FROM parent.step_name
     OR request_body->>'framework' IS DISTINCT FROM parent.framework
     OR jsonb_typeof(request_body->'reservation_ttl_seconds') IS DISTINCT FROM 'number'
     OR request_body->>'reservation_ttl_seconds'
       IS DISTINCT FROM parent.reservation_ttl_seconds::TEXT
     OR request_body->>'kind' IS DISTINCT FROM parent.kind THEN
    RAISE EXCEPTION 'stored reservation request contradicts typed request fields'
      USING ERRCODE = '23514';
  END IF;

  IF parent.kind = 'llm' THEN
    IF (request_body - ARRAY[
          'schema_version', 'mode', 'operation_id', 'customer_id', 'trace_id',
          'span_id', 'parent_span_id', 'step_name', 'framework',
          'reservation_ttl_seconds', 'kind', 'provider', 'model',
          'estimated_input_tokens', 'max_output_tokens'
        ]::TEXT[]) <> '{}'::JSONB
       OR jsonb_typeof(request_body->'provider') IS DISTINCT FROM 'string'
       OR request_body->>'provider' IS DISTINCT FROM parent.provider
       OR jsonb_typeof(request_body->'model') IS DISTINCT FROM 'string'
       OR request_body->>'model' IS DISTINCT FROM parent.model
       OR jsonb_typeof(request_body->'estimated_input_tokens') IS DISTINCT FROM 'number'
       OR request_body->>'estimated_input_tokens'
         IS DISTINCT FROM parent.estimated_input_tokens::TEXT
       OR jsonb_typeof(request_body->'max_output_tokens') IS DISTINCT FROM 'number'
       OR request_body->>'max_output_tokens'
         IS DISTINCT FROM parent.max_output_tokens::TEXT THEN
      RAISE EXCEPTION 'stored LLM reservation request is not canonical'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (request_body - ARRAY[
          'schema_version', 'mode', 'operation_id', 'customer_id', 'trace_id',
          'span_id', 'parent_span_id', 'step_name', 'framework',
          'reservation_ttl_seconds', 'kind', 'cost_source_slug', 'tool_name',
          'metric', 'maximum_value'
        ]::TEXT[]) <> '{}'::JSONB
       OR jsonb_typeof(request_body->'cost_source_slug') IS DISTINCT FROM 'string'
       OR request_body->>'cost_source_slug' IS DISTINCT FROM parent.cost_source_slug
       OR jsonb_typeof(request_body->'tool_name') IS DISTINCT FROM 'string'
       OR request_body->>'tool_name' IS DISTINCT FROM parent.tool_name
       OR jsonb_typeof(request_body->'metric') IS DISTINCT FROM 'string'
       OR request_body->>'metric' IS DISTINCT FROM parent.metric
       OR jsonb_typeof(request_body->'maximum_value') IS DISTINCT FROM 'string'
       OR request_body->>'maximum_value' IS DISTINCT FROM
         public.pylva_budget_decimal_text(parent.maximum_value) THEN
      RAISE EXCEPTION 'stored tool reservation request is not canonical'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF jsonb_typeof(response_body->'schema_version') IS DISTINCT FROM 'string'
     OR response_body->>'schema_version' IS DISTINCT FROM parent.schema_version
     OR response_body->>'decision' IS DISTINCT FROM parent.decision
     OR NOT public.pylva_budget_jsonb_uuid_matches(
       response_body->'operation_id', parent.operation_id
     )
     OR jsonb_typeof(response_body->'allowed') IS DISTINCT FROM 'boolean'
     OR (response_body->>'allowed')::BOOLEAN IS DISTINCT FROM
       (parent.decision IN ('reserved', 'bypassed')) THEN
    RAISE EXCEPTION 'stored reserve response contradicts its decision'
      USING ERRCODE = '23514';
  END IF;

  IF response_body ? 'warnings'
     AND jsonb_typeof(response_body->'warnings') = 'array' THEN
    IF jsonb_array_length(response_body->'warnings') <> (
      SELECT COUNT(*)
      FROM public.budget_reservation_allocations allocation
      WHERE allocation.builder_id = tenant_id
        AND allocation.reservation_decision_id = reservation_decision
        AND allocation.enforcement = 'advisory'
        AND allocation.projected_usd > allocation.limit_usd
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(response_body->'warnings') warning
      WHERE jsonb_typeof(warning) IS DISTINCT FROM 'object'
         OR (warning - ARRAY[
              'code', 'rule_id', 'limit_usd', 'projected_usd'
            ]::TEXT[]) <> '{}'::JSONB
         OR warning->>'code' IS DISTINCT FROM 'advisory_budget_exceeded'
         OR jsonb_typeof(warning->'limit_usd') IS DISTINCT FROM 'string'
         OR jsonb_typeof(warning->'projected_usd') IS DISTINCT FROM 'string'
         OR NOT EXISTS (
           SELECT 1
           FROM public.budget_reservation_allocations allocation
           WHERE allocation.builder_id = tenant_id
             AND allocation.reservation_decision_id = reservation_decision
             AND allocation.enforcement = 'advisory'
             AND allocation.projected_usd > allocation.limit_usd
             AND public.pylva_budget_jsonb_uuid_matches(
               warning->'rule_id', allocation.rule_key
             )
             AND warning->>'limit_usd' =
               public.pylva_budget_decimal_text(allocation.limit_usd)
             AND warning->>'projected_usd' =
               public.pylva_budget_decimal_text(allocation.projected_usd)
         )
    ) OR EXISTS (
      SELECT 1
      FROM public.budget_reservation_allocations allocation
      WHERE allocation.builder_id = tenant_id
        AND allocation.reservation_decision_id = reservation_decision
        AND allocation.enforcement = 'advisory'
        AND allocation.projected_usd > allocation.limit_usd
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(response_body->'warnings') warning
          WHERE public.pylva_budget_jsonb_uuid_matches(
                  warning->'rule_id', allocation.rule_key
                )
            AND warning->>'limit_usd' =
              public.pylva_budget_decimal_text(allocation.limit_usd)
            AND warning->>'projected_usd' =
              public.pylva_budget_decimal_text(allocation.projected_usd)
        )
    ) THEN
      RAISE EXCEPTION 'reserve response warnings do not match advisory evaluations'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF parent.decision = 'reserved' THEN
    IF (response_body - ARRAY[
          'schema_version', 'decision', 'allowed', 'decision_id', 'operation_id',
          'reservation_id', 'state', 'reserved_usd', 'remaining_usd',
          'expires_at', 'warnings'
        ]::TEXT[]) <> '{}'::JSONB
       OR NOT public.pylva_budget_jsonb_uuid_matches(
         response_body->'decision_id', parent.decision_id
       )
       OR NOT public.pylva_budget_jsonb_uuid_matches(
         response_body->'reservation_id', parent.reservation_id
       )
       OR response_body->>'state' IS DISTINCT FROM 'reserved'
       OR jsonb_typeof(response_body->'reserved_usd') IS DISTINCT FROM 'string'
       OR response_body->>'reserved_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(parent.reserved_usd)
       OR NOT (response_body ? 'remaining_usd')
       OR jsonb_typeof(response_body->'remaining_usd') IS DISTINCT FROM
         (CASE WHEN parent.remaining_usd IS NULL THEN 'null' ELSE 'string' END)
       OR response_body->>'remaining_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(parent.remaining_usd)
       OR response_body->>'expires_at' IS DISTINCT FROM
         public.pylva_budget_timestamp_text(
           parent.reserved_at
             + make_interval(secs => parent.reservation_ttl_seconds)
         )
       OR jsonb_typeof(response_body->'warnings') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'stored reserved response is not canonical'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'denied' THEN
    SELECT *
    INTO allocation_row
    FROM public.budget_reservation_allocations
    WHERE builder_id = tenant_id
      AND reservation_decision_id = reservation_decision
      AND is_deciding;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'denied response has no deciding allocation'
        USING ERRCODE = '23514';
    END IF;

    SELECT *
    INTO account_row
    FROM public.budget_accounts
    WHERE builder_id = tenant_id AND id = allocation_row.account_id;

    IF (response_body - ARRAY[
          'schema_version', 'decision', 'allowed', 'decision_id', 'operation_id',
          'state', 'deciding_rule', 'committed_usd', 'reserved_usd',
          'unresolved_usd', 'requested_usd', 'limit_usd', 'remaining_usd',
          'warnings'
        ]::TEXT[]) <> '{}'::JSONB
       OR NOT public.pylva_budget_jsonb_uuid_matches(
         response_body->'decision_id', parent.decision_id
       )
       OR response_body->>'state' IS DISTINCT FROM 'refused'
       OR jsonb_typeof(response_body->'deciding_rule') IS DISTINCT FROM 'object'
       OR ((response_body->'deciding_rule') - ARRAY[
            'rule_id', 'scope', 'customer_id', 'period',
            'period_start', 'period_end'
          ]::TEXT[]) <> '{}'::JSONB
       OR NOT public.pylva_budget_jsonb_uuid_matches(
         response_body#>'{deciding_rule,rule_id}', allocation_row.rule_key
       )
       OR response_body#>>'{deciding_rule,scope}' IS DISTINCT FROM account_row.scope
       OR NOT ((response_body#>'{deciding_rule,customer_id}') IS NOT DISTINCT FROM
         CASE
           WHEN account_row.subject_customer_id IS NULL THEN 'null'::JSONB
           ELSE to_jsonb(account_row.subject_customer_id)
         END)
       OR response_body#>>'{deciding_rule,period}' IS DISTINCT FROM account_row.period
       OR response_body#>>'{deciding_rule,period_start}' IS DISTINCT FROM
         public.pylva_budget_timestamp_text(account_row.period_start)
       OR response_body#>>'{deciding_rule,period_end}' IS DISTINCT FROM
         public.pylva_budget_timestamp_text(account_row.period_end)
       OR jsonb_typeof(response_body->'committed_usd') IS DISTINCT FROM 'string'
       OR jsonb_typeof(response_body->'reserved_usd') IS DISTINCT FROM 'string'
       OR jsonb_typeof(response_body->'unresolved_usd') IS DISTINCT FROM 'string'
       OR jsonb_typeof(response_body->'requested_usd') IS DISTINCT FROM 'string'
       OR jsonb_typeof(response_body->'limit_usd') IS DISTINCT FROM 'string'
       OR jsonb_typeof(response_body->'remaining_usd') IS DISTINCT FROM 'string'
       OR response_body->>'committed_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(allocation_row.committed_before_usd)
       OR response_body->>'reserved_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(allocation_row.reserved_before_usd)
       OR response_body->>'unresolved_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(allocation_row.unresolved_before_usd)
       OR response_body->>'requested_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(allocation_row.requested_usd)
       OR response_body->>'limit_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(allocation_row.limit_usd)
       OR response_body->>'remaining_usd' IS DISTINCT FROM
         public.pylva_budget_decimal_text(allocation_row.remaining_usd)
       OR jsonb_typeof(response_body->'warnings') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'stored denied response is not canonical'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'bypassed' THEN
    IF (response_body - ARRAY[
          'schema_version', 'decision', 'allowed', 'decision_id', 'operation_id',
          'reason', 'would_have_denied', 'warnings'
        ]::TEXT[]) <> '{}'::JSONB
       OR response_body->>'reason' IS DISTINCT FROM parent.decision_reason
       OR NOT ((response_body->'would_have_denied') IS NOT DISTINCT FROM
         CASE
           WHEN parent.would_have_denied IS NULL THEN 'null'::JSONB
           ELSE to_jsonb(parent.would_have_denied)
         END)
       OR jsonb_typeof(response_body->'warnings') IS DISTINCT FROM 'array'
       OR (
         parent.decision_reason = 'control_disabled'
         AND response_body->'decision_id' IS DISTINCT FROM 'null'::JSONB
       )
       OR (
         parent.decision_reason <> 'control_disabled'
         AND NOT public.pylva_budget_jsonb_uuid_matches(
           response_body->'decision_id', parent.decision_id
         )
       ) THEN
      RAISE EXCEPTION 'stored bypass response is not canonical'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (response_body - ARRAY[
          'schema_version', 'decision', 'allowed', 'decision_id', 'operation_id',
          'reason', 'retryable'
        ]::TEXT[]) <> '{}'::JSONB
       OR NOT (response_body ? 'decision_id')
       OR NOT (
         response_body->'decision_id' IS NOT DISTINCT FROM 'null'::JSONB
         OR public.pylva_budget_jsonb_uuid_matches(
           response_body->'decision_id', parent.decision_id
         )
       )
       OR response_body->>'reason' IS DISTINCT FROM parent.decision_reason
       OR jsonb_typeof(response_body->'retryable') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'stored unavailable response is not canonical'
        USING ERRCODE = '23514';
    END IF;
  END IF;
END;
$$;

-------------------------------------------------------------------
-- Lookup, locking, idempotency, expiry, and worker indexes.
-------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_budget_accounts_builder_period
  ON budget_accounts (
    builder_id, period_start, period_end, rule_key, scope, subject_customer_id, id
  );
CREATE INDEX IF NOT EXISTS idx_budget_accounts_builder_rule
  ON budget_accounts (builder_id, rule_key);

CREATE UNIQUE INDEX IF NOT EXISTS budget_rule_revisions_one_active_uk
  ON budget_rule_revisions (builder_id, rule_key)
  WHERE retired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_budget_rule_revisions_builder_rule
  ON budget_rule_revisions (builder_id, rule_key, revision DESC);
CREATE INDEX IF NOT EXISTS idx_budget_rule_revisions_active_scope
  ON budget_rule_revisions (
    builder_id, scope, target_customer_id, period, rule_key, id
  )
  WHERE retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS budget_reservations_reservation_uk
  ON budget_reservations (builder_id, reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budget_reservations_builder_customer_created
  ON budget_reservations (builder_id, customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_expiry
  ON budget_reservations (expires_at, builder_id, decision_id)
  WHERE state = 'reserved';
CREATE INDEX IF NOT EXISTS idx_budget_reservations_builder_state_updated
  ON budget_reservations (builder_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_builder_authorization_tx
  ON budget_reservations (builder_id, authorization_transaction_id);

CREATE INDEX IF NOT EXISTS idx_budget_reservation_allocations_account
  ON budget_reservation_allocations (builder_id, account_id, status)
  INCLUDE (authorized_usd, actual_usd, unresolved_usd);
CREATE INDEX IF NOT EXISTS idx_budget_reservation_allocations_decision_status
  ON budget_reservation_allocations (builder_id, reservation_decision_id, status)
  INCLUDE (account_id, is_deciding, requested_usd, actual_usd);
CREATE UNIQUE INDEX IF NOT EXISTS budget_reservation_allocations_observed_version_uk
  ON budget_reservation_allocations (
    builder_id, account_id, account_version_before
  )
  WHERE held_at_reserve;
CREATE UNIQUE INDEX IF NOT EXISTS budget_reservation_allocations_deciding_uk
  ON budget_reservation_allocations (builder_id, reservation_decision_id)
  WHERE is_deciding;

CREATE UNIQUE INDEX IF NOT EXISTS budget_reservation_transitions_idempotency_uk
  ON budget_reservation_transitions (
    builder_id, reservation_decision_id, type, extension_id
  ) NULLS NOT DISTINCT;
-- This index is deliberately separate from the per-type idempotency identity:
-- an application bug can never persist both commit and release as terminals.
CREATE UNIQUE INDEX IF NOT EXISTS budget_reservation_transitions_terminal_uk
  ON budget_reservation_transitions (builder_id, reservation_decision_id)
  WHERE type IN ('commit', 'release');
CREATE UNIQUE INDEX IF NOT EXISTS budget_reservation_transitions_from_version_uk
  ON budget_reservation_transitions (
    builder_id, reservation_decision_id, from_state_version
  );
CREATE UNIQUE INDEX IF NOT EXISTS budget_reservation_transitions_to_version_uk
  ON budget_reservation_transitions (
    builder_id, reservation_decision_id, to_state_version
  );
CREATE INDEX IF NOT EXISTS idx_budget_reservation_transitions_decision_occurred
  ON budget_reservation_transitions (
    builder_id, reservation_decision_id, occurred_at, id
  );

CREATE INDEX IF NOT EXISTS idx_budget_usage_ledger_builder_committed
  ON budget_usage_ledger (builder_id, committed_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_budget_usage_ledger_retain_until
  ON budget_usage_ledger (retain_until, builder_id, id);
CREATE INDEX IF NOT EXISTS idx_budget_usage_ledger_purge_ready
  ON budget_usage_ledger (builder_id, retain_until, id)
  WHERE details_purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_budget_usage_ledger_trace
  ON budget_usage_ledger (builder_id, trace_id, committed_at DESC);

CREATE INDEX IF NOT EXISTS idx_budget_cost_event_outbox_pending
  ON budget_cost_event_outbox (available_at, created_at, builder_id, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_budget_cost_event_outbox_expired_lease
  ON budget_cost_event_outbox (lock_expires_at, builder_id, id)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_budget_cost_event_outbox_builder_status
  ON budget_cost_event_outbox (builder_id, status, updated_at DESC);

-------------------------------------------------------------------
-- Tenant isolation. FORCE makes table owners obey the same policy as the
-- runtime NOBYPASSRLS role; application transactions must set app.builder_id.
-------------------------------------------------------------------
ALTER TABLE budget_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_accounts_isolation ON budget_accounts;
CREATE POLICY budget_accounts_isolation ON budget_accounts
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

ALTER TABLE budget_rule_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_rule_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_rule_revisions_isolation ON budget_rule_revisions;
CREATE POLICY budget_rule_revisions_isolation ON budget_rule_revisions
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_reservations_isolation ON budget_reservations;
CREATE POLICY budget_reservations_isolation ON budget_reservations
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

ALTER TABLE budget_reservation_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_reservation_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_reservation_allocations_isolation
  ON budget_reservation_allocations;
CREATE POLICY budget_reservation_allocations_isolation
  ON budget_reservation_allocations
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

ALTER TABLE budget_reservation_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_reservation_transitions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_reservation_transitions_isolation
  ON budget_reservation_transitions;
CREATE POLICY budget_reservation_transitions_isolation
  ON budget_reservation_transitions
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

ALTER TABLE budget_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_usage_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_usage_ledger_isolation ON budget_usage_ledger;
CREATE POLICY budget_usage_ledger_isolation ON budget_usage_ledger
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

ALTER TABLE budget_cost_event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_cost_event_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS budget_cost_event_outbox_isolation ON budget_cost_event_outbox;
CREATE POLICY budget_cost_event_outbox_isolation ON budget_cost_event_outbox
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::uuid)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::uuid);

-------------------------------------------------------------------
-- Immutable snapshots and legal mutable lifecycle surfaces.
-------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pylva_budget_accounts_immutability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  posting_changed BOOLEAN;
  revision_row public.budget_rule_revisions%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NULLIF(current_setting('app.builder_id', true), '')::uuid
         IS DISTINCT FROM NEW.builder_id THEN
      RAISE EXCEPTION 'budget account builder_id does not match tenant context'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.budget_reservations reservation
      WHERE reservation.builder_id = NEW.builder_id
        AND reservation.authorization_transaction_id = txid_current()
    ) THEN
      RAISE EXCEPTION 'budget accounts must be materialized before reservations in the same transaction'
        USING ERRCODE = '25001';
    END IF;

    -- Account materialization is rare and takes an exclusive builder-scoped
    -- transaction lock. Reservation decisions take the shared form, allowing
    -- normal reservations to remain concurrent while giving configuration
    -- changes a strict before/after commit order.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(NEW.builder_id::TEXT, 50620260714)
    );

    SELECT *
    INTO revision_row
    FROM public.budget_rule_revisions
    WHERE builder_id = NEW.builder_id
      AND id = NEW.initial_rule_revision_id
      AND rule_key = NEW.rule_key
      AND retired_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'new budget account requires the active global rule revision'
        USING ERRCODE = '23503';
    END IF;
    IF revision_row.scope IS DISTINCT FROM NEW.scope
       OR revision_row.period IS DISTINCT FROM NEW.period
       OR revision_row.enforcement IS DISTINCT FROM NEW.enforcement
       OR revision_row.limit_usd IS DISTINCT FROM NEW.limit_usd
       OR (
         revision_row.scope = 'per_customer'
         AND revision_row.target_customer_id IS NOT NULL
         AND revision_row.target_customer_id IS DISTINCT FROM NEW.subject_customer_id
       ) THEN
      RAISE EXCEPTION 'budget account bucket does not match its active global rule revision'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.version <> 0 THEN
      RAISE EXCEPTION 'new budget accounts must start at version zero'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.committed_usd IS DISTINCT FROM NEW.opening_committed_usd
       OR NEW.reserved_usd <> 0
       OR NEW.unresolved_usd <> 0 THEN
      RAISE EXCEPTION 'new budget accounts must start at their opening committed balance with no active postings'
        USING ERRCODE = '23514';
    END IF;
    NEW.created_at := date_trunc('milliseconds', clock_timestamp());
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_accounts rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.builder_id IS DISTINCT FROM NEW.builder_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.rule_key IS DISTINCT FROM NEW.rule_key
     OR OLD.enforcement IS DISTINCT FROM NEW.enforcement
     OR OLD.limit_usd IS DISTINCT FROM NEW.limit_usd
     OR OLD.scope IS DISTINCT FROM NEW.scope
     OR OLD.subject_customer_id IS DISTINCT FROM NEW.subject_customer_id
     OR OLD.period IS DISTINCT FROM NEW.period
     OR OLD.period_start IS DISTINCT FROM NEW.period_start
     OR OLD.period_end IS DISTINCT FROM NEW.period_end
     OR OLD.initial_rule_revision_id IS DISTINCT FROM NEW.initial_rule_revision_id
     OR OLD.initial_rule_snapshot IS DISTINCT FROM NEW.initial_rule_snapshot
     OR OLD.initial_rule_snapshot_hash IS DISTINCT FROM NEW.initial_rule_snapshot_hash
     OR OLD.opening_committed_usd IS DISTINCT FROM NEW.opening_committed_usd
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'budget_accounts identity and snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version < OLD.version OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'budget_accounts version and updated_at cannot move backward'
      USING ERRCODE = '55000';
  END IF;

  posting_changed :=
    OLD.version IS DISTINCT FROM NEW.version
    OR OLD.committed_usd IS DISTINCT FROM NEW.committed_usd
    OR OLD.reserved_usd IS DISTINCT FROM NEW.reserved_usd
    OR OLD.unresolved_usd IS DISTINCT FROM NEW.unresolved_usd;

  -- Posting counters are a materialized projection owned by the allocation
  -- posting trigger. A direct account UPDATE enters this trigger at depth one;
  -- the authorized allocation -> account trigger chain enters at depth two.
  -- Rejecting direct mutation here avoids an O(history) deferred reconciliation
  -- scan on every posting while the explicit reconciliation function below
  -- remains available for audits and repair tooling.
  IF posting_changed AND pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'budget account postings may change only from the allocation posting trigger'
      USING ERRCODE = '55000';
  END IF;

  IF (
       OLD.committed_usd IS DISTINCT FROM NEW.committed_usd
       OR OLD.reserved_usd IS DISTINCT FROM NEW.reserved_usd
       OR OLD.unresolved_usd IS DISTINCT FROM NEW.unresolved_usd
     ) AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'budget_accounts counter mutations must increment version exactly once'
      USING ERRCODE = '55000';
  ELSIF OLD.committed_usd IS NOT DISTINCT FROM NEW.committed_usd
        AND OLD.reserved_usd IS NOT DISTINCT FROM NEW.reserved_usd
        AND OLD.unresolved_usd IS NOT DISTINCT FROM NEW.unresolved_usd
        AND NEW.version <> OLD.version THEN
    IF NEW.version <> OLD.version + 1 OR NOT EXISTS (
      SELECT 1
      FROM public.budget_reservation_allocations allocation
      WHERE allocation.builder_id = OLD.builder_id
        AND allocation.account_id = OLD.id
        AND allocation.account_version_before = OLD.version
        AND allocation.held_at_reserve
        AND allocation.authorized_usd = 0
    ) THEN
      RAISE EXCEPTION 'budget_accounts version-only changes require a serialized zero-dollar hold'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.version IS DISTINCT FROM OLD.version
     OR NEW.committed_usd IS DISTINCT FROM OLD.committed_usd
     OR NEW.reserved_usd IS DISTINCT FROM OLD.reserved_usd
     OR NEW.unresolved_usd IS DISTINCT FROM OLD.unresolved_usd THEN
    NEW.updated_at := GREATEST(
      OLD.updated_at,
      date_trunc('milliseconds', clock_timestamp())
    );
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_accounts_immutability_guard ON budget_accounts;
CREATE TRIGGER budget_accounts_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON budget_accounts
FOR EACH ROW EXECUTE FUNCTION pylva_budget_accounts_immutability_guard();

CREATE OR REPLACE FUNCTION pylva_budget_rule_revisions_immutability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_revision public.budget_rule_revisions%ROWTYPE;
  authoritative_now TIMESTAMPTZ;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM COALESCE(NEW.builder_id, OLD.builder_id) THEN
    RAISE EXCEPTION 'budget-control tenant context does not match rule revision tenant'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_rule_revisions rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.budget_reservations reservation
    WHERE reservation.builder_id = COALESCE(NEW.builder_id, OLD.builder_id)
      AND reservation.authorization_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'rule configuration cannot change after a reservation in the same transaction'
      USING ERRCODE = '25001';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(COALESCE(NEW.builder_id, OLD.builder_id)::TEXT, 50620260714)
  );
  authoritative_now := date_trunc('milliseconds', clock_timestamp());

  IF TG_OP = 'UPDATE' THEN
    IF OLD.retired_at IS NOT NULL
       OR NEW.retirement_reason IS NULL
       OR NEW.retirement_reason NOT IN ('superseded', 'disabled', 'deleted')
       OR (to_jsonb(OLD) - ARRAY['retired_at', 'retirement_reason']::TEXT[])
            IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY['retired_at', 'retirement_reason']::TEXT[]) THEN
      RAISE EXCEPTION 'rule revisions permit only one server-timed retirement'
        USING ERRCODE = '55000';
    END IF;
    NEW.retired_at := GREATEST(OLD.active_from, authoritative_now);
    RETURN NEW;
  END IF;

  SELECT *
  INTO previous_revision
  FROM public.budget_rule_revisions
  WHERE builder_id = NEW.builder_id
    AND rule_key = NEW.rule_key
  ORDER BY revision DESC
  LIMIT 1;

  IF FOUND THEN
    IF previous_revision.retired_at IS NULL THEN
      RAISE EXCEPTION 'active rule revision must be retired before replacement'
        USING ERRCODE = '55000';
    END IF;
    IF previous_revision.retirement_reason = 'deleted' THEN
      RAISE EXCEPTION 'a deleted budget rule cannot be reactivated'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.scope IS DISTINCT FROM previous_revision.scope
       OR NEW.target_customer_id IS DISTINCT FROM previous_revision.target_customer_id
       OR NEW.period IS DISTINCT FROM previous_revision.period THEN
      RAISE EXCEPTION 'scope, customer targeting, and period are immutable across rule revisions'
        USING ERRCODE = '23514';
    END IF;
    NEW.revision := previous_revision.revision + 1;
    NEW.active_from := CASE
      WHEN previous_revision.retirement_reason = 'superseded'
        THEN previous_revision.retired_at
      ELSE GREATEST(previous_revision.retired_at, authoritative_now)
    END;
  ELSE
    NEW.revision := 0;
    NEW.active_from := authoritative_now;
  END IF;

  NEW.created_at := NEW.active_from;
  NEW.retired_at := NULL;
  NEW.retirement_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_rule_revisions_immutability_guard
  ON budget_rule_revisions;
CREATE TRIGGER budget_rule_revisions_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON budget_rule_revisions
FOR EACH ROW EXECUTE FUNCTION pylva_budget_rule_revisions_immutability_guard();

DROP TRIGGER IF EXISTS budget_accounts_initial_rule_revision_guard
  ON budget_accounts;
DROP FUNCTION IF EXISTS pylva_budget_initialize_account_revision();

CREATE OR REPLACE FUNCTION pylva_budget_assert_revision_successors(
  tenant_id UUID,
  stable_rule_key UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match rule revision tenant'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.budget_rule_revisions retired
    WHERE retired.builder_id = tenant_id
      AND retired.rule_key = stable_rule_key
      AND retired.retirement_reason = 'superseded'
      AND NOT EXISTS (
        SELECT 1
        FROM public.budget_rule_revisions successor
        WHERE successor.builder_id = retired.builder_id
          AND successor.rule_key = retired.rule_key
          AND successor.revision = retired.revision + 1
          AND successor.active_from = retired.retired_at
      )
  ) THEN
    RAISE EXCEPTION 'a superseded rule revision requires its immediate successor in the same transaction'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_revision_successor_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_revision_successors(NEW.builder_id, NEW.rule_key);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_rule_revisions_successor_consistency_guard
  ON budget_rule_revisions;
CREATE CONSTRAINT TRIGGER budget_rule_revisions_successor_consistency_guard
AFTER INSERT OR UPDATE ON budget_rule_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_revision_successor_consistency_guard();

CREATE OR REPLACE FUNCTION pylva_budget_reservations_immutability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  authoritative_now TIMESTAMPTZ;
  lifecycle_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NULLIF(current_setting('app.builder_id', true), '')::uuid
         IS DISTINCT FROM NEW.builder_id THEN
      RAISE EXCEPTION 'budget-control tenant context does not match reservation tenant'
        USING ERRCODE = '42501';
    END IF;
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'authoritative reservation decisions require READ COMMITTED isolation'
        USING ERRCODE = '25001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended(NEW.builder_id::TEXT, 50620260714)
    );

    authoritative_now := date_trunc('milliseconds', clock_timestamp());
    NEW.created_at := authoritative_now;
    NEW.updated_at := authoritative_now;
    NEW.authorization_transaction_id := txid_current();
    SELECT COALESCE(
      array_agg(revision.id ORDER BY revision.id),
      ARRAY[]::UUID[]
    )
    INTO NEW.rule_revision_ids
    FROM public.budget_rule_revisions revision
    WHERE revision.builder_id = NEW.builder_id
      AND revision.retired_at IS NULL
      AND (
        revision.target_customer_id IS NULL
        OR revision.target_customer_id = NEW.customer_id
      );
    NEW.rule_set_hash := public.pylva_budget_jsonb_sha256(
      to_jsonb(NEW.rule_revision_ids)
    );

    IF NEW.decision = 'reserved' THEN
      IF NEW.state IS DISTINCT FROM 'reserved' OR NEW.state_version <> 0 THEN
        RAISE EXCEPTION 'new held reservations must start in reserved state at version zero'
          USING ERRCODE = '23514';
      END IF;
      NEW.reserved_at := authoritative_now;
      NEW.expires_at :=
        authoritative_now + make_interval(secs => NEW.reservation_ttl_seconds);
      NEW.reserve_response_snapshot := jsonb_set(
        NEW.reserve_response_snapshot,
        '{expires_at}',
        to_jsonb(public.pylva_budget_timestamp_text(NEW.expires_at)),
        TRUE
      );
    ELSIF NEW.decision = 'denied' THEN
      NEW.refused_at := authoritative_now;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_reservations rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.builder_id IS DISTINCT FROM NEW.builder_id
     OR OLD.decision_id IS DISTINCT FROM NEW.decision_id
     OR OLD.reservation_id IS DISTINCT FROM NEW.reservation_id
     OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
     OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.request_snapshot IS DISTINCT FROM NEW.request_snapshot
     OR OLD.mode IS DISTINCT FROM NEW.mode
     OR OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.customer_id IS DISTINCT FROM NEW.customer_id
     OR OLD.trace_id IS DISTINCT FROM NEW.trace_id
     OR OLD.span_id IS DISTINCT FROM NEW.span_id
     OR OLD.parent_span_id IS DISTINCT FROM NEW.parent_span_id
     OR OLD.step_name IS DISTINCT FROM NEW.step_name
     OR OLD.framework IS DISTINCT FROM NEW.framework
     OR OLD.reservation_ttl_seconds IS DISTINCT FROM NEW.reservation_ttl_seconds
     OR OLD.provider IS DISTINCT FROM NEW.provider
     OR OLD.model IS DISTINCT FROM NEW.model
     OR OLD.estimated_input_tokens IS DISTINCT FROM NEW.estimated_input_tokens
     OR OLD.max_output_tokens IS DISTINCT FROM NEW.max_output_tokens
     OR OLD.cost_source_slug IS DISTINCT FROM NEW.cost_source_slug
     OR OLD.tool_name IS DISTINCT FROM NEW.tool_name
     OR OLD.metric IS DISTINCT FROM NEW.metric
     OR OLD.maximum_value IS DISTINCT FROM NEW.maximum_value
     OR OLD.decision IS DISTINCT FROM NEW.decision
     OR OLD.decision_reason IS DISTINCT FROM NEW.decision_reason
     OR OLD.would_have_denied IS DISTINCT FROM NEW.would_have_denied
     OR OLD.pricing_snapshot IS DISTINCT FROM NEW.pricing_snapshot
     OR OLD.pricing_snapshot_hash IS DISTINCT FROM NEW.pricing_snapshot_hash
     OR OLD.requested_usd IS DISTINCT FROM NEW.requested_usd
     OR OLD.reserved_usd IS DISTINCT FROM NEW.reserved_usd
     OR OLD.remaining_usd IS DISTINCT FROM NEW.remaining_usd
     OR OLD.deciding_account_id IS DISTINCT FROM NEW.deciding_account_id
     OR OLD.reserve_response_snapshot IS DISTINCT FROM NEW.reserve_response_snapshot
     OR OLD.rule_revision_ids IS DISTINCT FROM NEW.rule_revision_ids
     OR OLD.rule_set_hash IS DISTINCT FROM NEW.rule_set_hash
     OR OLD.authorization_transaction_id IS DISTINCT FROM NEW.authorization_transaction_id
     OR OLD.reserved_at IS DISTINCT FROM NEW.reserved_at
     OR OLD.refused_at IS DISTINCT FROM NEW.refused_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'budget_reservations request, decision, and pricing snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  lifecycle_changed :=
    OLD.state IS DISTINCT FROM NEW.state
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.actual_usd IS DISTINCT FROM NEW.actual_usd
    OR OLD.released_usd IS DISTINCT FROM NEW.released_usd
    OR OLD.overage_usd IS DISTINCT FROM NEW.overage_usd
    OR OLD.committed_at IS DISTINCT FROM NEW.committed_at
    OR OLD.released_at IS DISTINCT FROM NEW.released_at
    OR OLD.unresolved_at IS DISTINCT FROM NEW.unresolved_at
    OR OLD.unresolved_reason IS DISTINCT FROM NEW.unresolved_reason;

  IF OLD.state IN ('committed', 'released', 'refused') AND lifecycle_changed THEN
    RAISE EXCEPTION 'terminal budget_reservations lifecycle is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state IS DISTINCT FROM NEW.state AND NOT (
    (OLD.state = 'reserved' AND NEW.state IN ('committed', 'released', 'unresolved'))
    OR (OLD.state = 'unresolved' AND NEW.state IN ('committed', 'released'))
  ) THEN
    RAISE EXCEPTION 'illegal budget_reservations lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state IS DISTINCT FROM NEW.state
     AND OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
    RAISE EXCEPTION 'settlement cannot rewrite reservation expiry'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.state = NEW.state
     AND OLD.expires_at IS DISTINCT FROM NEW.expires_at
     AND NOT (
       OLD.state = 'reserved'
       AND public.pylva_budget_timestamp_is_wire_safe(OLD.expires_at)
       AND public.pylva_budget_timestamp_is_wire_safe(NEW.expires_at)
       AND OLD.expires_at > clock_timestamp()
       AND NEW.expires_at - OLD.expires_at BETWEEN INTERVAL '30 seconds' AND INTERVAL '3600 seconds'
     ) THEN
    RAISE EXCEPTION 'only a live reservation lease may be extended'
      USING ERRCODE = '55000';
  END IF;

  IF lifecycle_changed AND NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'lifecycle mutations must increment state_version exactly once'
      USING ERRCODE = '55000';
  ELSIF NOT lifecycle_changed AND NEW.state_version <> OLD.state_version THEN
    RAISE EXCEPTION 'state_version may change only with a lifecycle mutation'
      USING ERRCODE = '55000';
  END IF;

  IF lifecycle_changed THEN
    authoritative_now := date_trunc('milliseconds', clock_timestamp());
    NEW.updated_at := authoritative_now;

    IF OLD.state IS DISTINCT FROM NEW.state THEN
      IF NEW.state = 'committed' THEN
        NEW.committed_at := authoritative_now;
      ELSIF NEW.state = 'released' THEN
        NEW.released_at := authoritative_now;
      ELSIF NEW.state = 'unresolved' THEN
        NEW.unresolved_at := authoritative_now;
      END IF;
    END IF;
  ELSE
    -- A no-op caller cannot future-date the row and poison a later,
    -- server-stamped settlement.
    NEW.updated_at := OLD.updated_at;
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'budget_reservations updated_at cannot move backward'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservations_immutability_guard ON budget_reservations;
CREATE TRIGGER budget_reservations_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON budget_reservations
FOR EACH ROW EXECUTE FUNCTION pylva_budget_reservations_immutability_guard();

-- Allocation insertion is the serialized authorization boundary. It locks the
-- referenced account, proves the snapshot was observed at that exact version,
-- and rejects customer/rule/period substitution before any hold is posted.
CREATE OR REPLACE FUNCTION pylva_budget_allocation_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  account_row public.budget_accounts%ROWTYPE;
  authorization_now TIMESTAMPTZ;
  expected_rule_snapshot JSONB;
  parent public.budget_reservations%ROWTYPE;
  revision_row public.budget_rule_revisions%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM NEW.builder_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match allocation tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO parent
  FROM public.budget_reservations
  WHERE builder_id = NEW.builder_id
    AND decision_id = NEW.reservation_decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation has no matching reservation'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO account_row
  FROM public.budget_accounts
  WHERE builder_id = NEW.builder_id
    AND id = NEW.account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation has no matching budget account'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO revision_row
  FROM public.budget_rule_revisions
  WHERE builder_id = NEW.builder_id
    AND id = NEW.rule_revision_id
    AND rule_key = NEW.rule_key;

  IF NOT FOUND OR NOT (NEW.rule_revision_id = ANY(parent.rule_revision_ids)) THEN
    RAISE EXCEPTION 'allocation rule revision was not in the reservation rule set'
      USING ERRCODE = '23514';
  END IF;

  -- Stamp after acquiring the account row lock. A lock wait must not preserve
  -- a stale period or make authorization appear earlier than it really was.
  authorization_now := date_trunc('milliseconds', clock_timestamp());
  NEW.created_at := authorization_now;
  NEW.updated_at := NEW.created_at;

  expected_rule_snapshot := jsonb_build_object(
    'schema_version', '1.0',
    'rule_key', account_row.rule_key::TEXT,
    'scope', account_row.scope,
    'subject_customer_id', account_row.subject_customer_id,
    'period', account_row.period,
    'period_start', public.pylva_budget_timestamp_text(account_row.period_start),
    'period_end', public.pylva_budget_timestamp_text(account_row.period_end),
    'enforcement', revision_row.enforcement,
    'limit_usd', public.pylva_budget_decimal_text(revision_row.limit_usd),
    'opening_committed_usd',
      public.pylva_budget_decimal_text(account_row.opening_committed_usd)
  );

  IF account_row.rule_key IS DISTINCT FROM NEW.rule_key
     OR revision_row.scope IS DISTINCT FROM account_row.scope
     OR revision_row.period IS DISTINCT FROM account_row.period
     OR (
       revision_row.target_customer_id IS NOT NULL
       AND revision_row.target_customer_id IS DISTINCT FROM parent.customer_id
     )
     OR NEW.rule_snapshot IS DISTINCT FROM expected_rule_snapshot
     OR NEW.rule_snapshot_hash IS DISTINCT FROM
       public.pylva_budget_jsonb_sha256(expected_rule_snapshot)
     OR revision_row.enforcement IS DISTINCT FROM NEW.enforcement
     OR revision_row.limit_usd IS DISTINCT FROM NEW.limit_usd
     OR account_row.version IS DISTINCT FROM NEW.account_version_before
     OR account_row.committed_usd IS DISTINCT FROM NEW.committed_before_usd
     OR account_row.reserved_usd IS DISTINCT FROM NEW.reserved_before_usd
     OR account_row.unresolved_usd IS DISTINCT FROM NEW.unresolved_before_usd THEN
    RAISE EXCEPTION 'allocation snapshot does not match its locked budget account'
      USING ERRCODE = '40001';
  END IF;

  IF (account_row.scope = 'per_customer'
      AND account_row.subject_customer_id IS DISTINCT FROM parent.customer_id)
     OR authorization_now < account_row.period_start
     OR authorization_now >= account_row.period_end THEN
    RAISE EXCEPTION 'allocation account does not match reservation customer or period'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.requested_usd IS DISTINCT FROM parent.requested_usd THEN
    RAISE EXCEPTION 'allocation amount does not match reservation request'
      USING ERRCODE = '23514';
  END IF;

  IF parent.decision = 'reserved' THEN
    IF parent.state IS DISTINCT FROM 'reserved'
       OR NEW.status <> 'reserved'
       OR NOT NEW.held_at_reserve THEN
      RAISE EXCEPTION 'a new held allocation requires an initially reserved parent'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'denied' THEN
    IF NEW.held_at_reserve OR NEW.status NOT IN ('refused', 'not_held') THEN
      RAISE EXCEPTION 'a denied decision cannot post a budget hold'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'bypassed'
        AND parent.decision_reason IN ('shadow_would_allow', 'shadow_would_deny') THEN
    IF NEW.held_at_reserve OR NEW.status <> 'shadow' THEN
      RAISE EXCEPTION 'a shadow decision can record evaluation but cannot post a hold'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'non-evaluated decisions cannot insert allocations'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservation_allocations_insert_guard
  ON budget_reservation_allocations;
CREATE TRIGGER budget_reservation_allocations_insert_guard
BEFORE INSERT ON budget_reservation_allocations
FOR EACH ROW EXECUTE FUNCTION pylva_budget_allocation_insert_guard();

CREATE OR REPLACE FUNCTION pylva_budget_allocations_immutability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  settlement_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_reservation_allocations rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.builder_id IS DISTINCT FROM NEW.builder_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.reservation_decision_id IS DISTINCT FROM NEW.reservation_decision_id
     OR OLD.account_id IS DISTINCT FROM NEW.account_id
     OR OLD.rule_key IS DISTINCT FROM NEW.rule_key
     OR OLD.rule_revision_id IS DISTINCT FROM NEW.rule_revision_id
     OR OLD.rule_snapshot IS DISTINCT FROM NEW.rule_snapshot
     OR OLD.rule_snapshot_hash IS DISTINCT FROM NEW.rule_snapshot_hash
     OR OLD.enforcement IS DISTINCT FROM NEW.enforcement
     OR OLD.evaluation_order IS DISTINCT FROM NEW.evaluation_order
     OR OLD.is_deciding IS DISTINCT FROM NEW.is_deciding
     OR OLD.account_version_before IS DISTINCT FROM NEW.account_version_before
     OR OLD.held_at_reserve IS DISTINCT FROM NEW.held_at_reserve
     OR OLD.committed_before_usd IS DISTINCT FROM NEW.committed_before_usd
     OR OLD.reserved_before_usd IS DISTINCT FROM NEW.reserved_before_usd
     OR OLD.unresolved_before_usd IS DISTINCT FROM NEW.unresolved_before_usd
     OR OLD.requested_usd IS DISTINCT FROM NEW.requested_usd
     OR OLD.projected_usd IS DISTINCT FROM NEW.projected_usd
     OR OLD.limit_usd IS DISTINCT FROM NEW.limit_usd
     OR OLD.remaining_usd IS DISTINCT FROM NEW.remaining_usd
     OR OLD.authorized_usd IS DISTINCT FROM NEW.authorized_usd
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'budget_reservation_allocations decision snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  settlement_changed :=
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.actual_usd IS DISTINCT FROM NEW.actual_usd
    OR OLD.released_usd IS DISTINCT FROM NEW.released_usd
    OR OLD.unresolved_usd IS DISTINCT FROM NEW.unresolved_usd
    OR OLD.overage_usd IS DISTINCT FROM NEW.overage_usd;

  IF OLD.status IN ('committed', 'released', 'refused', 'not_held', 'shadow')
     AND settlement_changed THEN
    RAISE EXCEPTION 'terminal budget_reservation_allocations state is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('committed', 'released', 'unresolved'))
    OR (OLD.status = 'unresolved' AND NEW.status IN ('committed', 'released'))
  ) THEN
    RAISE EXCEPTION 'illegal budget_reservation_allocations lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = NEW.status AND settlement_changed THEN
    RAISE EXCEPTION 'allocation settlement values require a lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF settlement_changed THEN
    NEW.updated_at := date_trunc('milliseconds', clock_timestamp());
  ELSE
    -- Preserve the server-owned lifecycle timestamp on no-op updates.
    NEW.updated_at := OLD.updated_at;
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'budget_reservation_allocations updated_at cannot move backward'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservation_allocations_immutability_guard
  ON budget_reservation_allocations;
CREATE TRIGGER budget_reservation_allocations_immutability_guard
BEFORE UPDATE OR DELETE ON budget_reservation_allocations
FOR EACH ROW EXECUTE FUNCTION pylva_budget_allocations_immutability_guard();

-- Account counters are posted only as a consequence of an allocation state
-- change. Because the insert guard already holds the account row lock, this
-- update both serializes concurrent authorizations and makes stale snapshots
-- fail before provider authorization can be returned.
CREATE OR REPLACE FUNCTION pylva_budget_apply_allocation_posting()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.held_at_reserve THEN
      UPDATE public.budget_accounts
      SET reserved_usd = reserved_usd + NEW.authorized_usd,
          version = version + 1,
          updated_at = GREATEST(
            updated_at,
            date_trunc('milliseconds', clock_timestamp())
          )
      WHERE builder_id = NEW.builder_id
        AND id = NEW.account_id
        AND version = NEW.account_version_before;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'budget account changed before reservation hold was posted'
          USING ERRCODE = '40001';
      END IF;
    END IF;
    RETURN NULL;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;

  -- A zero-dollar hold consumes one serialized account version at reserve
  -- time, but a later zero-to-zero lifecycle transition has no counter delta
  -- and therefore must not fabricate another posting version.
  IF (OLD.status = 'reserved' AND NEW.status = 'committed'
      AND OLD.authorized_usd = 0 AND NEW.actual_usd = 0)
     OR (OLD.status = 'reserved' AND NEW.status IN ('released', 'unresolved')
         AND OLD.authorized_usd = 0)
     OR (OLD.status = 'unresolved' AND NEW.status = 'committed'
         AND OLD.unresolved_usd = 0 AND NEW.actual_usd = 0)
     OR (OLD.status = 'unresolved' AND NEW.status = 'released'
         AND OLD.unresolved_usd = 0) THEN
    RETURN NULL;
  END IF;

  IF OLD.status = 'reserved' AND NEW.status = 'committed' THEN
    UPDATE public.budget_accounts
    SET committed_usd = committed_usd + NEW.actual_usd,
        reserved_usd = reserved_usd - OLD.authorized_usd,
        version = version + 1,
        updated_at = GREATEST(
          updated_at,
          date_trunc('milliseconds', clock_timestamp())
        )
    WHERE builder_id = NEW.builder_id AND id = NEW.account_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'released' THEN
    UPDATE public.budget_accounts
    SET reserved_usd = reserved_usd - OLD.authorized_usd,
        version = version + 1,
        updated_at = GREATEST(
          updated_at,
          date_trunc('milliseconds', clock_timestamp())
        )
    WHERE builder_id = NEW.builder_id AND id = NEW.account_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'unresolved' THEN
    UPDATE public.budget_accounts
    SET reserved_usd = reserved_usd - OLD.authorized_usd,
        unresolved_usd = unresolved_usd + NEW.unresolved_usd,
        version = version + 1,
        updated_at = GREATEST(
          updated_at,
          date_trunc('milliseconds', clock_timestamp())
        )
    WHERE builder_id = NEW.builder_id AND id = NEW.account_id;
  ELSIF OLD.status = 'unresolved' AND NEW.status = 'committed' THEN
    UPDATE public.budget_accounts
    SET committed_usd = committed_usd + NEW.actual_usd,
        unresolved_usd = unresolved_usd - OLD.unresolved_usd,
        version = version + 1,
        updated_at = GREATEST(
          updated_at,
          date_trunc('milliseconds', clock_timestamp())
        )
    WHERE builder_id = NEW.builder_id AND id = NEW.account_id;
  ELSIF OLD.status = 'unresolved' AND NEW.status = 'released' THEN
    UPDATE public.budget_accounts
    SET unresolved_usd = unresolved_usd - OLD.unresolved_usd,
        version = version + 1,
        updated_at = GREATEST(
          updated_at,
          date_trunc('milliseconds', clock_timestamp())
        )
    WHERE builder_id = NEW.builder_id AND id = NEW.account_id;
  ELSE
    RAISE EXCEPTION 'allocation transition has no authoritative account posting'
      USING ERRCODE = '55000';
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation posting lost its budget account'
      USING ERRCODE = '23503';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservation_allocations_posting_guard
  ON budget_reservation_allocations;
CREATE TRIGGER budget_reservation_allocations_posting_guard
AFTER INSERT OR UPDATE ON budget_reservation_allocations
FOR EACH ROW EXECUTE FUNCTION pylva_budget_apply_allocation_posting();

CREATE OR REPLACE FUNCTION pylva_budget_append_only_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent public.budget_reservations%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NULLIF(current_setting('app.builder_id', true), '')::UUID
         IS DISTINCT FROM NEW.builder_id THEN
      RAISE EXCEPTION 'budget-control tenant context does not match transition tenant'
        USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO parent
    FROM public.budget_reservations
    WHERE builder_id = NEW.builder_id
      AND decision_id = NEW.reservation_decision_id
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'reservation lifecycle must exist before its transition'
        USING ERRCODE = '23503';
    END IF;

    IF parent.state IS DISTINCT FROM NEW.to_state
       OR parent.state_version IS DISTINCT FROM NEW.to_state_version
       OR parent.expires_at IS DISTINCT FROM NEW.to_expires_at THEN
      RAISE EXCEPTION 'reservation lifecycle must be updated before its transition is appended'
        USING ERRCODE = '23514';
    END IF;

    NEW.occurred_at := CASE NEW.type
      WHEN 'extend' THEN parent.updated_at
      WHEN 'commit' THEN parent.committed_at
      WHEN 'release' THEN parent.released_at
      WHEN 'expire_unresolved' THEN parent.unresolved_at
    END;

    IF NEW.occurred_at IS NULL THEN
      RAISE EXCEPTION 'reservation lifecycle has no authoritative transition timestamp'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.type = 'extend' THEN
      NEW.response_snapshot := jsonb_set(
        NEW.response_snapshot,
        '{expires_at}',
        to_jsonb(public.pylva_budget_timestamp_text(NEW.to_expires_at)),
        TRUE
      );
    ELSIF NEW.type = 'release' THEN
      NEW.response_snapshot := jsonb_set(
        NEW.response_snapshot,
        '{released_at}',
        to_jsonb(public.pylva_budget_timestamp_text(NEW.occurred_at)),
        TRUE
      );
    ELSIF NEW.type = 'commit' THEN
      NEW.response_snapshot := jsonb_set(
        NEW.response_snapshot,
        '{committed_at}',
        to_jsonb(public.pylva_budget_timestamp_text(NEW.occurred_at)),
        TRUE
      );
    ELSIF NEW.type = 'expire_unresolved' THEN
      NEW.response_snapshot := jsonb_set(
        NEW.response_snapshot,
        '{unresolved_at}',
        to_jsonb(public.pylva_budget_timestamp_text(NEW.occurred_at)),
        TRUE
      );
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% rows are append-only and immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS budget_reservation_transitions_append_only_guard
  ON budget_reservation_transitions;
CREATE TRIGGER budget_reservation_transitions_append_only_guard
BEFORE INSERT OR UPDATE OR DELETE ON budget_reservation_transitions
FOR EACH ROW EXECUTE FUNCTION pylva_budget_append_only_guard();

CREATE OR REPLACE FUNCTION pylva_budget_usage_immutability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  outbox_row public.budget_cost_event_outbox%ROWTYPE;
  parent public.budget_reservations%ROWTYPE;
  purge_timestamp TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NULLIF(current_setting('app.builder_id', true), '')::uuid
         IS DISTINCT FROM NEW.builder_id THEN
      RAISE EXCEPTION 'budget-control tenant context does not match usage tenant'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.details_purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'new authoritative usage cannot start as a tombstone'
        USING ERRCODE = '23514';
    END IF;

    SELECT *
    INTO parent
    FROM public.budget_reservations
    WHERE builder_id = NEW.builder_id
      AND decision_id = NEW.reservation_decision_id
      AND operation_id = NEW.operation_id
    FOR KEY SHARE;

    IF NOT FOUND OR parent.state <> 'committed' OR parent.committed_at IS NULL THEN
      RAISE EXCEPTION 'authoritative usage requires an already committed reservation'
        USING ERRCODE = '23514';
    END IF;

    NEW.committed_at := parent.committed_at;
    NEW.retain_until :=
      parent.committed_at + NEW.billing_retention_days * INTERVAL '1 day';
    NEW.created_at := date_trunc('milliseconds', clock_timestamp());
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_usage_ledger rows cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.details_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged authoritative usage tombstones are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (to_jsonb(OLD) - ARRAY[
        'pricing_snapshot', 'usage_snapshot', 'metadata', 'details_purged_at'
      ]::TEXT[])
       IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'pricing_snapshot', 'usage_snapshot', 'metadata', 'details_purged_at'
      ]::TEXT[])
     OR NEW.pricing_snapshot IS NOT NULL
     OR NEW.usage_snapshot IS NOT NULL
     OR NEW.metadata IS NOT NULL THEN
    RAISE EXCEPTION 'usage updates may only remove retained JSON details'
      USING ERRCODE = '55000';
  END IF;

  IF clock_timestamp() < OLD.retain_until THEN
    RAISE EXCEPTION 'authoritative usage details are still within retention'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO outbox_row
  FROM public.budget_cost_event_outbox
  WHERE builder_id = OLD.builder_id
    AND usage_ledger_id = OLD.id
    AND cost_event_id = OLD.cost_event_id;

  IF NOT FOUND
     OR outbox_row.status <> 'projected'
     OR outbox_row.projection_verified_at IS NULL
     OR outbox_row.projection_verified_at > clock_timestamp() THEN
    RAISE EXCEPTION 'usage details require a reconciliation-verified projection before purge'
      USING ERRCODE = '55000';
  END IF;

  purge_timestamp := outbox_row.payload_purged_at;
  IF purge_timestamp IS NULL THEN
    purge_timestamp := date_trunc('milliseconds', clock_timestamp());
  END IF;
  NEW.details_purged_at := purge_timestamp;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_usage_ledger_append_only_guard ON budget_usage_ledger;
DROP TRIGGER IF EXISTS budget_usage_ledger_immutability_guard ON budget_usage_ledger;
CREATE TRIGGER budget_usage_ledger_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON budget_usage_ledger
FOR EACH ROW EXECUTE FUNCTION pylva_budget_usage_immutability_guard();

-- Commit and billable usage are one atomic fact. The parent lifecycle is
-- updated first so its fresh database timestamp can be copied into usage;
-- deferred checks then make a committed-without-usage transaction fail at
-- COMMIT regardless of later child/outbox statement order.
CREATE OR REPLACE FUNCTION pylva_budget_usage_parent_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  outbox_row public.budget_cost_event_outbox%ROWTYPE;
  parent public.budget_reservations%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM NEW.builder_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match usage tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO parent
  FROM public.budget_reservations
  WHERE builder_id = NEW.builder_id
    AND decision_id = NEW.reservation_decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'authoritative usage has no matching reservation'
      USING ERRCODE = '23503';
  END IF;

  IF parent.state IS DISTINCT FROM 'committed'
     OR parent.operation_id IS DISTINCT FROM NEW.operation_id
     OR parent.customer_id IS DISTINCT FROM NEW.customer_id
     OR parent.trace_id IS DISTINCT FROM NEW.trace_id
     OR parent.span_id IS DISTINCT FROM NEW.span_id
     OR parent.parent_span_id IS DISTINCT FROM NEW.parent_span_id
     OR parent.step_name IS DISTINCT FROM NEW.step_name
     OR parent.framework IS DISTINCT FROM NEW.framework
     OR parent.kind IS DISTINCT FROM NEW.kind
     OR parent.provider IS DISTINCT FROM NEW.provider
     OR parent.model IS DISTINCT FROM NEW.model
     OR parent.cost_source_slug IS DISTINCT FROM NEW.cost_source_slug
     OR parent.tool_name IS DISTINCT FROM NEW.tool_name
     OR parent.metric IS DISTINCT FROM NEW.metric
     OR parent.actual_usd IS DISTINCT FROM NEW.actual_cost_usd
     OR parent.pricing_snapshot_hash IS DISTINCT FROM NEW.pricing_snapshot_hash
     OR (
       NEW.details_purged_at IS NULL
       AND parent.pricing_snapshot IS DISTINCT FROM NEW.pricing_snapshot
     )
     OR parent.committed_at IS DISTINCT FROM NEW.committed_at THEN
    RAISE EXCEPTION 'authoritative usage does not match its committed reservation'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO outbox_row
  FROM public.budget_cost_event_outbox
  WHERE builder_id = NEW.builder_id
    AND usage_ledger_id = NEW.id
    AND cost_event_id = NEW.cost_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'authoritative usage requires a transactional outbox row'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.details_purged_at IS NULL AND (
       outbox_row.payload_schema_version IS DISTINCT FROM '1.6'
       OR outbox_row.payload IS DISTINCT FROM
         public.pylva_budget_cost_event_payload(NEW)
       OR outbox_row.payload_hash IS DISTINCT FROM
         public.pylva_budget_jsonb_sha256(outbox_row.payload)
     ) THEN
    RAISE EXCEPTION 'transactional outbox payload does not match authoritative usage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_usage_ledger_parent_consistency_guard
  ON budget_usage_ledger;
CREATE CONSTRAINT TRIGGER budget_usage_ledger_parent_consistency_guard
AFTER INSERT OR UPDATE ON budget_usage_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_usage_parent_consistency_guard();

CREATE OR REPLACE FUNCTION pylva_budget_reservation_usage_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent public.budget_reservations%ROWTYPE;
  usage_row public.budget_usage_ledger%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM NEW.builder_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match reservation tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO parent
  FROM public.budget_reservations
  WHERE builder_id = NEW.builder_id
    AND decision_id = NEW.decision_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation disappeared before usage consistency validation'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO usage_row
  FROM public.budget_usage_ledger
  WHERE builder_id = parent.builder_id
    AND reservation_decision_id = parent.decision_id;

  IF parent.state = 'committed' THEN
    IF NOT FOUND THEN
      RAISE EXCEPTION 'committed reservation requires authoritative usage in the same transaction'
        USING ERRCODE = '23514';
    END IF;

    IF usage_row.operation_id IS DISTINCT FROM parent.operation_id
       OR usage_row.actual_cost_usd IS DISTINCT FROM parent.actual_usd
       OR usage_row.committed_at IS DISTINCT FROM parent.committed_at THEN
      RAISE EXCEPTION 'committed reservation does not match authoritative usage'
        USING ERRCODE = '23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'non-committed reservation cannot own authoritative usage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservations_usage_consistency_guard
  ON budget_reservations;
CREATE CONSTRAINT TRIGGER budget_reservations_usage_consistency_guard
AFTER INSERT OR UPDATE ON budget_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_reservation_usage_consistency_guard();

CREATE OR REPLACE FUNCTION pylva_budget_assert_retention_tombstone_pair(
  tenant_id UUID,
  usage_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  outbox_row public.budget_cost_event_outbox%ROWTYPE;
  usage_row public.budget_usage_ledger%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match retention tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO usage_row
  FROM public.budget_usage_ledger
  WHERE builder_id = tenant_id AND id = usage_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention tombstone has no authoritative usage row'
      USING ERRCODE = '23503';
  END IF;

  SELECT *
  INTO outbox_row
  FROM public.budget_cost_event_outbox
  WHERE builder_id = tenant_id
    AND usage_ledger_id = usage_id
    AND cost_event_id = usage_row.cost_event_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'retention tombstone has no matching outbox row'
      USING ERRCODE = '23503';
  END IF;

  IF (usage_row.details_purged_at IS NULL)
       IS DISTINCT FROM (outbox_row.payload_purged_at IS NULL) THEN
    RAISE EXCEPTION 'usage details and outbox payload must be purged atomically'
      USING ERRCODE = '23514';
  END IF;

  IF usage_row.details_purged_at IS NOT NULL AND (
       usage_row.details_purged_at IS DISTINCT FROM outbox_row.payload_purged_at
       OR usage_row.details_purged_at < usage_row.retain_until
       OR usage_row.pricing_snapshot IS NOT NULL
       OR usage_row.usage_snapshot IS NOT NULL
       OR usage_row.metadata IS NOT NULL
       OR outbox_row.payload IS NOT NULL
       OR outbox_row.status <> 'projected'
       OR outbox_row.projection_verified_at IS NULL
     ) THEN
    RAISE EXCEPTION 'retention tombstone pair is incomplete or unverified'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_usage_retention_pair_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_retention_tombstone_pair(
    NEW.builder_id,
    NEW.id
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_outbox_retention_pair_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_retention_tombstone_pair(
    NEW.builder_id,
    NEW.usage_ledger_id
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_usage_ledger_retention_pair_guard
  ON budget_usage_ledger;
CREATE CONSTRAINT TRIGGER budget_usage_ledger_retention_pair_guard
AFTER INSERT OR UPDATE ON budget_usage_ledger
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_usage_retention_pair_guard();

DROP TRIGGER IF EXISTS budget_cost_event_outbox_retention_pair_guard
  ON budget_cost_event_outbox;
CREATE CONSTRAINT TRIGGER budget_cost_event_outbox_retention_pair_guard
AFTER INSERT OR UPDATE ON budget_cost_event_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_outbox_retention_pair_guard();

CREATE OR REPLACE FUNCTION pylva_budget_assert_reservation_transitions(
  tenant_id UUID,
  reservation_decision UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  budget_exceeded_after_commit BOOLEAN;
  expected_expiry TIMESTAMPTZ;
  expected_state VARCHAR(20);
  expected_version BIGINT := 0;
  parent public.budget_reservations%ROWTYPE;
  previous_occurred_at TIMESTAMPTZ;
  transition_row public.budget_reservation_transitions%ROWTYPE;
  usage_row public.budget_usage_ledger%ROWTYPE;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match transition tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO parent
  FROM public.budget_reservations
  WHERE builder_id = tenant_id
    AND decision_id = reservation_decision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation transition has no matching reservation'
      USING ERRCODE = '23503';
  END IF;

  IF parent.decision <> 'reserved' THEN
    IF parent.state_version <> 0 OR EXISTS (
      SELECT 1
      FROM public.budget_reservation_transitions
      WHERE builder_id = tenant_id
        AND reservation_decision_id = reservation_decision
    ) THEN
      RAISE EXCEPTION 'non-reserved decisions cannot have lifecycle transitions'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  expected_state := 'reserved';
  expected_expiry :=
    parent.reserved_at + make_interval(secs => parent.reservation_ttl_seconds);
  previous_occurred_at := parent.reserved_at;

  FOR transition_row IN
    SELECT *
    FROM public.budget_reservation_transitions
    WHERE builder_id = tenant_id
      AND reservation_decision_id = reservation_decision
    ORDER BY from_state_version, id
  LOOP
    IF transition_row.from_state_version IS DISTINCT FROM expected_version
       OR transition_row.to_state_version IS DISTINCT FROM expected_version + 1
       OR transition_row.from_state IS DISTINCT FROM expected_state
       OR transition_row.from_expires_at IS DISTINCT FROM expected_expiry
       OR transition_row.occurred_at < previous_occurred_at THEN
      RAISE EXCEPTION 'reservation transition chain is not contiguous'
        USING ERRCODE = '23514';
    END IF;

    IF jsonb_typeof(transition_row.request_snapshot->'schema_version')
         IS DISTINCT FROM 'string'
       OR jsonb_typeof(transition_row.response_snapshot->'schema_version')
         IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'reservation transition schema_version must be a JSON string'
        USING ERRCODE = '23514';
    END IF;

    IF transition_row.type = 'extend' THEN
      IF (transition_row.request_snapshot - ARRAY[
            'schema_version', 'extension_id', 'extend_by_seconds'
          ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.request_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR jsonb_typeof(transition_row.request_snapshot->'extension_id')
           IS DISTINCT FROM 'string'
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.request_snapshot->'extension_id',
           transition_row.extension_id
         )
         OR jsonb_typeof(transition_row.request_snapshot->'extend_by_seconds')
           IS DISTINCT FROM 'number'
         OR transition_row.request_snapshot->>'extend_by_seconds'
           IS DISTINCT FROM transition_row.extend_by_seconds::TEXT
         OR (transition_row.response_snapshot - ARRAY[
              'schema_version', 'state', 'reservation_id', 'operation_id',
              'extension_id', 'expires_at', 'idempotent_replay'
            ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.response_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'reservation_id',
           parent.reservation_id
         )
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'operation_id',
           parent.operation_id
         )
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'extension_id',
           transition_row.extension_id
         )
         OR jsonb_typeof(transition_row.response_snapshot->'expires_at')
           IS DISTINCT FROM 'string'
         OR transition_row.response_snapshot->>'expires_at'
           IS DISTINCT FROM
             public.pylva_budget_timestamp_text(transition_row.to_expires_at)
         OR transition_row.response_snapshot->>'state'
           IS DISTINCT FROM 'reserved'
         OR transition_row.response_snapshot->'idempotent_replay'
           IS DISTINCT FROM 'false'::JSONB THEN
        RAISE EXCEPTION 'extension transition snapshots do not match typed fields'
          USING ERRCODE = '23514';
      END IF;
    ELSIF transition_row.type = 'release' THEN
      IF (transition_row.request_snapshot - ARRAY[
            'schema_version', 'reason'
          ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.request_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR transition_row.request_snapshot->>'reason'
           IS DISTINCT FROM transition_row.release_reason
         OR (transition_row.response_snapshot - ARRAY[
              'schema_version', 'state', 'reservation_id', 'operation_id',
              'released_usd', 'released_at', 'idempotent_replay'
            ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.response_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR transition_row.response_snapshot->>'state' IS DISTINCT FROM 'released'
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'reservation_id',
           parent.reservation_id
         )
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'operation_id',
           parent.operation_id
         )
         OR jsonb_typeof(transition_row.response_snapshot->'released_usd')
           IS DISTINCT FROM 'string'
         OR jsonb_typeof(transition_row.response_snapshot->'released_at')
           IS DISTINCT FROM 'string'
         OR transition_row.response_snapshot->>'released_usd'
           IS DISTINCT FROM public.pylva_budget_decimal_text(parent.reserved_usd)
         OR transition_row.response_snapshot->>'released_at'
           IS DISTINCT FROM public.pylva_budget_timestamp_text(transition_row.occurred_at)
         OR transition_row.response_snapshot->'idempotent_replay'
           IS DISTINCT FROM 'false'::JSONB THEN
        RAISE EXCEPTION 'release transition snapshots do not match typed fields'
          USING ERRCODE = '23514';
      END IF;
    ELSIF transition_row.type = 'commit' THEN
      SELECT *
      INTO usage_row
      FROM public.budget_usage_ledger
      WHERE builder_id = tenant_id
        AND reservation_decision_id = reservation_decision;

      IF NOT FOUND
         OR usage_row.usage_snapshot_hash IS DISTINCT FROM transition_row.request_hash
         OR (
           usage_row.details_purged_at IS NULL
           AND usage_row.usage_snapshot IS DISTINCT FROM transition_row.request_snapshot
         )
         OR transition_row.request_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR transition_row.request_snapshot->>'status' IS DISTINCT FROM usage_row.status
         OR jsonb_typeof(transition_row.request_snapshot->'latency_ms')
           IS DISTINCT FROM 'number'
         OR transition_row.request_snapshot->>'latency_ms'
           IS DISTINCT FROM usage_row.latency_ms::TEXT
         OR transition_row.request_snapshot->'stream_aborted'
           IS DISTINCT FROM to_jsonb(usage_row.stream_aborted)
         OR transition_row.request_snapshot->>'kind' IS DISTINCT FROM usage_row.kind THEN
        RAISE EXCEPTION 'commit transition request does not match authoritative usage'
          USING ERRCODE = '23514';
      END IF;

      IF usage_row.kind = 'llm' AND (
           (transition_row.request_snapshot - ARRAY[
              'schema_version', 'status', 'latency_ms', 'stream_aborted',
              'kind', 'actual_input_tokens', 'actual_output_tokens'
            ]::TEXT[]) <> '{}'::JSONB
           OR jsonb_typeof(transition_row.request_snapshot->'actual_input_tokens')
             IS DISTINCT FROM 'number'
           OR jsonb_typeof(transition_row.request_snapshot->'actual_output_tokens')
             IS DISTINCT FROM 'number'
           OR transition_row.request_snapshot->>'actual_input_tokens'
             IS DISTINCT FROM usage_row.actual_input_tokens::TEXT
           OR transition_row.request_snapshot->>'actual_output_tokens'
             IS DISTINCT FROM usage_row.actual_output_tokens::TEXT
         ) THEN
        RAISE EXCEPTION 'commit LLM request snapshot is not canonical'
          USING ERRCODE = '23514';
      ELSIF usage_row.kind = 'tool' AND (
           (transition_row.request_snapshot - ARRAY[
              'schema_version', 'status', 'latency_ms', 'stream_aborted',
              'kind', 'actual_value'
            ]::TEXT[]) <> '{}'::JSONB
           OR jsonb_typeof(transition_row.request_snapshot->'actual_value')
             IS DISTINCT FROM 'string'
           OR transition_row.request_snapshot->>'actual_value'
             IS DISTINCT FROM public.pylva_budget_decimal_text(usage_row.actual_value)
         ) THEN
        RAISE EXCEPTION 'commit tool request snapshot is not canonical'
          USING ERRCODE = '23514';
      END IF;

      SELECT COALESCE(BOOL_OR(
        allocation.enforcement = 'hard_stop'
        AND account.committed_usd
          + account.reserved_usd
          + account.unresolved_usd > allocation.limit_usd
      ), FALSE)
      INTO budget_exceeded_after_commit
      FROM public.budget_reservation_allocations allocation
      JOIN public.budget_accounts account
        ON account.builder_id = allocation.builder_id
       AND account.id = allocation.account_id
      WHERE allocation.builder_id = tenant_id
        AND allocation.reservation_decision_id = reservation_decision;

      IF (transition_row.response_snapshot - ARRAY[
            'schema_version', 'state', 'reservation_id', 'operation_id',
            'reserved_usd', 'actual_usd', 'released_usd', 'overage_usd',
            'budget_exceeded_after_commit', 'committed_at',
            'idempotent_replay', 'late'
          ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.response_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR transition_row.response_snapshot->>'state' IS DISTINCT FROM 'committed'
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'reservation_id',
           parent.reservation_id
         )
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'operation_id',
           parent.operation_id
         )
         OR jsonb_typeof(transition_row.response_snapshot->'reserved_usd')
           IS DISTINCT FROM 'string'
         OR jsonb_typeof(transition_row.response_snapshot->'actual_usd')
           IS DISTINCT FROM 'string'
         OR jsonb_typeof(transition_row.response_snapshot->'released_usd')
           IS DISTINCT FROM 'string'
         OR jsonb_typeof(transition_row.response_snapshot->'overage_usd')
           IS DISTINCT FROM 'string'
         OR jsonb_typeof(transition_row.response_snapshot->'committed_at')
           IS DISTINCT FROM 'string'
         OR transition_row.response_snapshot->>'reserved_usd'
           IS DISTINCT FROM public.pylva_budget_decimal_text(parent.reserved_usd)
         OR transition_row.response_snapshot->>'actual_usd'
           IS DISTINCT FROM public.pylva_budget_decimal_text(parent.actual_usd)
         OR transition_row.response_snapshot->>'released_usd'
           IS DISTINCT FROM public.pylva_budget_decimal_text(parent.released_usd)
         OR transition_row.response_snapshot->>'overage_usd'
           IS DISTINCT FROM public.pylva_budget_decimal_text(parent.overage_usd)
         OR transition_row.response_snapshot->'budget_exceeded_after_commit'
           IS DISTINCT FROM to_jsonb(budget_exceeded_after_commit)
         OR transition_row.response_snapshot->>'committed_at'
           IS DISTINCT FROM public.pylva_budget_timestamp_text(transition_row.occurred_at)
         OR transition_row.response_snapshot->'idempotent_replay'
           IS DISTINCT FROM 'false'::JSONB
         OR transition_row.response_snapshot->'late'
           IS DISTINCT FROM to_jsonb(transition_row.from_state = 'unresolved') THEN
        RAISE EXCEPTION 'commit transition response does not match settlement'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      IF (transition_row.request_snapshot - ARRAY[
            'schema_version', 'reason'
          ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.request_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR transition_row.request_snapshot->>'reason'
           IS DISTINCT FROM 'lease_expired'
         OR (transition_row.response_snapshot - ARRAY[
              'schema_version', 'state', 'reservation_id', 'operation_id',
              'unresolved_usd', 'unresolved_at', 'reason'
            ]::TEXT[]) <> '{}'::JSONB
         OR transition_row.response_snapshot->>'schema_version'
           IS DISTINCT FROM '1.0'
         OR transition_row.response_snapshot->>'state' IS DISTINCT FROM 'unresolved'
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'reservation_id',
           parent.reservation_id
         )
         OR NOT public.pylva_budget_jsonb_uuid_matches(
           transition_row.response_snapshot->'operation_id',
           parent.operation_id
         )
         OR jsonb_typeof(transition_row.response_snapshot->'unresolved_usd')
           IS DISTINCT FROM 'string'
         OR jsonb_typeof(transition_row.response_snapshot->'unresolved_at')
           IS DISTINCT FROM 'string'
         OR transition_row.response_snapshot->>'unresolved_usd'
           IS DISTINCT FROM public.pylva_budget_decimal_text(parent.reserved_usd)
         OR transition_row.response_snapshot->>'unresolved_at'
           IS DISTINCT FROM public.pylva_budget_timestamp_text(transition_row.occurred_at)
         OR transition_row.response_snapshot->>'reason'
           IS DISTINCT FROM 'lease_expired' THEN
        RAISE EXCEPTION 'expiry transition snapshots do not match unresolved state'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    expected_version := transition_row.to_state_version;
    expected_state := transition_row.to_state;
    expected_expiry := transition_row.to_expires_at;
    previous_occurred_at := transition_row.occurred_at;
  END LOOP;

  IF expected_version IS DISTINCT FROM parent.state_version
     OR expected_state IS DISTINCT FROM parent.state
     OR expected_expiry IS DISTINCT FROM parent.expires_at THEN
    RAISE EXCEPTION 'reservation state, version, or expiry does not match transition chain'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
  INTO transition_row
  FROM public.budget_reservation_transitions
  WHERE builder_id = tenant_id
    AND reservation_decision_id = reservation_decision
    AND to_state_version = parent.state_version;

  IF parent.state = 'committed' AND (
       NOT FOUND
       OR transition_row.type <> 'commit'
       OR transition_row.occurred_at IS DISTINCT FROM parent.committed_at
     ) THEN
    RAISE EXCEPTION 'committed reservation requires a matching final transition'
      USING ERRCODE = '23514';
  ELSIF parent.state = 'released' AND (
       NOT FOUND
       OR transition_row.type <> 'release'
       OR transition_row.occurred_at IS DISTINCT FROM parent.released_at
     ) THEN
    RAISE EXCEPTION 'released reservation requires a matching final transition'
      USING ERRCODE = '23514';
  ELSIF parent.state = 'unresolved' AND (
       NOT FOUND
       OR transition_row.type <> 'expire_unresolved'
       OR transition_row.occurred_at IS DISTINCT FROM parent.unresolved_at
     ) THEN
    RAISE EXCEPTION 'unresolved reservation requires a matching final transition'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_reservation_transition_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_reservation_transitions(
    NEW.builder_id,
    NEW.decision_id
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_transition_parent_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_reservation_transitions(
    NEW.builder_id,
    NEW.reservation_decision_id
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservations_transition_consistency_guard
  ON budget_reservations;
CREATE CONSTRAINT TRIGGER budget_reservations_transition_consistency_guard
AFTER INSERT OR UPDATE ON budget_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_reservation_transition_consistency_guard();

DROP TRIGGER IF EXISTS budget_reservation_transitions_parent_consistency_guard
  ON budget_reservation_transitions;
CREATE CONSTRAINT TRIGGER budget_reservation_transitions_parent_consistency_guard
AFTER INSERT ON budget_reservation_transitions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_transition_parent_consistency_guard();

CREATE OR REPLACE FUNCTION pylva_budget_assert_reservation_allocations(
  tenant_id UUID,
  reservation_decision UUID,
  require_current_account_set BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocation_count BIGINT;
  account_periods_match BOOLEAN := TRUE;
  account_sets_match BOOLEAN := TRUE;
  applicable_account_count BIGINT;
  authorization_now TIMESTAMPTZ;
  current_revision_ids UUID[];
  amounts_match BOOLEAN;
  deciding_count BIGINT;
  expected_remaining NUMERIC;
  first_violating_account_id UUID;
  parent public.budget_reservations%ROWTYPE;
  refused_count BIGINT;
  statuses_match BOOLEAN;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match allocation tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO parent
  FROM public.budget_reservations
  WHERE builder_id = tenant_id
    AND decision_id = reservation_decision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation has no matching reservation'
      USING ERRCODE = '23503';
  END IF;

  IF require_current_account_set
     AND parent.decision = 'reserved'
     AND parent.state = 'reserved'
     AND parent.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'reservation lease expired before authorization could commit'
      USING ERRCODE = '57014';
  END IF;

  applicable_account_count := 0;
  IF require_current_account_set THEN
    authorization_now := clock_timestamp();
    SELECT COALESCE(
      array_agg(revision.id ORDER BY revision.id),
      ARRAY[]::UUID[]
    )
    INTO current_revision_ids
    FROM public.budget_rule_revisions revision
    WHERE revision.builder_id = tenant_id
      AND revision.retired_at IS NULL
      AND (
        revision.target_customer_id IS NULL
        OR revision.target_customer_id = parent.customer_id
      );
    applicable_account_count := cardinality(current_revision_ids);

    WITH applicable AS (
      SELECT unnest(current_revision_ids) AS rule_revision_id
    ), allocated AS (
      SELECT allocation.rule_revision_id
      FROM public.budget_reservation_allocations allocation
      WHERE allocation.builder_id = tenant_id
        AND allocation.reservation_decision_id = reservation_decision
    )
    SELECT parent.rule_revision_ids IS NOT DISTINCT FROM current_revision_ids
      AND
      NOT EXISTS (
        SELECT rule_revision_id FROM applicable
        EXCEPT
        SELECT rule_revision_id FROM allocated
      )
      AND NOT EXISTS (
        SELECT rule_revision_id FROM allocated
        EXCEPT
        SELECT rule_revision_id FROM applicable
      )
    INTO account_sets_match;

    SELECT COALESCE(BOOL_AND(
      authorization_now >= account.period_start
      AND authorization_now < account.period_end
      AND account.scope = revision.scope
      AND account.period = revision.period
      AND (
        account.scope = 'pooled'
        OR account.subject_customer_id = parent.customer_id
      )
      AND (
        revision.target_customer_id IS NULL
        OR revision.target_customer_id = parent.customer_id
      )
    ), applicable_account_count = 0)
    INTO account_periods_match
    FROM public.budget_reservation_allocations allocation
    JOIN public.budget_accounts account
      ON account.builder_id = allocation.builder_id
     AND account.id = allocation.account_id
    JOIN public.budget_rule_revisions revision
      ON revision.builder_id = allocation.builder_id
     AND revision.id = allocation.rule_revision_id
     AND revision.rule_key = allocation.rule_key
    WHERE allocation.builder_id = tenant_id
      AND allocation.reservation_decision_id = reservation_decision;

    account_sets_match := account_sets_match AND account_periods_match;
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE is_deciding),
    COUNT(*) FILTER (WHERE status = 'refused'),
    COALESCE(BOOL_AND(
      requested_usd IS NOT DISTINCT FROM parent.requested_usd
      AND (
        parent.state IS DISTINCT FROM 'committed'
        OR (
          actual_usd = parent.actual_usd
          AND released_usd = parent.released_usd
          AND overage_usd = parent.overage_usd
          AND unresolved_usd = 0
        )
      )
      AND (
        parent.state IS DISTINCT FROM 'released'
        OR (
          actual_usd = 0
          AND released_usd = parent.reserved_usd
          AND unresolved_usd = 0
          AND overage_usd = 0
        )
      )
      AND (
        parent.state IS DISTINCT FROM 'unresolved'
        OR (
          actual_usd = 0
          AND released_usd = 0
          AND unresolved_usd = parent.reserved_usd
          AND overage_usd = 0
        )
      )
    ), FALSE),
    COALESCE(BOOL_AND(
      CASE
        WHEN parent.decision = 'reserved' THEN status = parent.state
        WHEN parent.decision = 'denied' THEN
          CASE
            WHEN enforcement = 'hard_stop' AND projected_usd > limit_usd
              THEN status = 'refused'
            ELSE status = 'not_held'
          END
        WHEN parent.decision = 'bypassed'
          AND parent.decision_reason IN ('shadow_would_allow', 'shadow_would_deny')
          THEN status = 'shadow'
        ELSE FALSE
      END
    ), FALSE)
  INTO allocation_count, deciding_count, refused_count, amounts_match, statuses_match
  FROM public.budget_reservation_allocations
  WHERE builder_id = tenant_id
    AND reservation_decision_id = reservation_decision;

  SELECT account_id
  INTO first_violating_account_id
  FROM public.budget_reservation_allocations
  WHERE builder_id = tenant_id
    AND reservation_decision_id = reservation_decision
    AND enforcement = 'hard_stop'
    AND projected_usd > limit_usd
  ORDER BY evaluation_order, account_id
  LIMIT 1;

  SELECT MIN(remaining_usd) FILTER (WHERE enforcement = 'hard_stop')
  INTO expected_remaining
  FROM public.budget_reservation_allocations
  WHERE builder_id = tenant_id
    AND reservation_decision_id = reservation_decision;

  IF parent.decision = 'reserved' THEN
    IF allocation_count = 0
       OR (
         require_current_account_set
         AND NOT account_sets_match
       )
       OR NOT statuses_match
       OR NOT amounts_match
       OR parent.remaining_usd IS DISTINCT FROM expected_remaining THEN
      RAISE EXCEPTION 'reserved lifecycle requires matching allocation settlement'
        USING ERRCODE = '23514';
    END IF;
    IF parent.deciding_account_id IS NOT NULL OR deciding_count <> 0 THEN
      RAISE EXCEPTION 'successful reservations cannot carry a denying allocation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'denied' THEN
    IF allocation_count = 0
       OR (
         require_current_account_set
         AND NOT account_sets_match
       )
       OR NOT statuses_match
       OR NOT amounts_match
       OR refused_count = 0
       OR parent.deciding_account_id IS NULL
       OR deciding_count <> 1
       OR parent.deciding_account_id IS DISTINCT FROM first_violating_account_id
       OR parent.remaining_usd IS DISTINCT FROM (
         SELECT remaining_usd
         FROM public.budget_reservation_allocations
         WHERE builder_id = tenant_id
           AND reservation_decision_id = reservation_decision
           AND is_deciding
       )
       OR NOT EXISTS (
         SELECT 1
         FROM public.budget_reservation_allocations allocation_row
         WHERE allocation_row.builder_id = tenant_id
           AND allocation_row.reservation_decision_id = reservation_decision
           AND allocation_row.account_id = parent.deciding_account_id
           AND allocation_row.is_deciding
       ) THEN
      RAISE EXCEPTION 'denial requires exactly one matching deciding allocation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'bypassed'
        AND parent.decision_reason IN ('shadow_would_allow', 'shadow_would_deny') THEN
    IF allocation_count = 0
       OR (
         require_current_account_set
         AND NOT account_sets_match
       )
       OR NOT statuses_match
       OR NOT amounts_match THEN
      RAISE EXCEPTION 'shadow decision requires matching shadow allocations'
        USING ERRCODE = '23514';
    END IF;
    IF parent.decision_reason = 'shadow_would_deny' AND (
      parent.deciding_account_id IS NULL
      OR deciding_count <> 1
      OR parent.deciding_account_id IS DISTINCT FROM first_violating_account_id
      OR NOT EXISTS (
        SELECT 1
        FROM public.budget_reservation_allocations allocation_row
        WHERE allocation_row.builder_id = tenant_id
          AND allocation_row.reservation_decision_id = reservation_decision
          AND allocation_row.account_id = parent.deciding_account_id
          AND allocation_row.is_deciding
      )
    ) THEN
      RAISE EXCEPTION 'shadow denial requires exactly one deciding allocation'
        USING ERRCODE = '23514';
    ELSIF parent.decision_reason = 'shadow_would_allow'
          AND (
            parent.deciding_account_id IS NOT NULL
            OR deciding_count <> 0
            OR first_violating_account_id IS NOT NULL
          ) THEN
      RAISE EXCEPTION 'shadow allow cannot carry a deciding allocation'
        USING ERRCODE = '23514';
    END IF;
  ELSIF parent.decision = 'bypassed'
        AND parent.decision_reason = 'no_applicable_budget' THEN
    IF allocation_count <> 0
       OR (
         require_current_account_set
         AND (applicable_account_count <> 0 OR NOT account_sets_match)
       )
       OR parent.deciding_account_id IS NOT NULL
       OR deciding_count <> 0 THEN
      RAISE EXCEPTION 'no_applicable_budget requires an empty applicable global rule revision set'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF allocation_count <> 0
       OR parent.deciding_account_id IS NOT NULL
       OR deciding_count <> 0 THEN
      RAISE EXCEPTION 'non-evaluated decisions cannot carry allocations'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM public.pylva_budget_assert_reservation_snapshots(
    tenant_id,
    reservation_decision
  );
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_reservation_allocations_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_reservation_allocations(
    NEW.builder_id,
    NEW.decision_id,
    TG_OP = 'INSERT'
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_allocation_reservation_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_reservation_allocations(
    NEW.builder_id,
    NEW.reservation_decision_id,
    TG_OP = 'INSERT'
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservations_allocations_consistency_guard
  ON budget_reservations;
CREATE CONSTRAINT TRIGGER budget_reservations_allocations_consistency_guard
AFTER INSERT OR UPDATE ON budget_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_reservation_allocations_consistency_guard();

DROP TRIGGER IF EXISTS budget_reservation_allocations_parent_consistency_guard
  ON budget_reservation_allocations;
CREATE CONSTRAINT TRIGGER budget_reservation_allocations_parent_consistency_guard
AFTER INSERT OR UPDATE ON budget_reservation_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION pylva_budget_allocation_reservation_consistency_guard();

CREATE OR REPLACE FUNCTION pylva_budget_assert_account_postings(
  tenant_id UUID,
  budget_account_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  account_row public.budget_accounts%ROWTYPE;
  expected_committed NUMERIC;
  expected_reserved NUMERIC;
  expected_unresolved NUMERIC;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match account tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO account_row
  FROM public.budget_accounts
  WHERE builder_id = tenant_id
    AND id = budget_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation has no matching budget account'
      USING ERRCODE = '23503';
  END IF;

  SELECT
    account_row.opening_committed_usd
      + COALESCE(SUM(CASE WHEN status = 'committed' THEN actual_usd ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'reserved' THEN authorized_usd ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN status = 'unresolved' THEN unresolved_usd ELSE 0 END), 0)
  INTO expected_committed, expected_reserved, expected_unresolved
  FROM public.budget_reservation_allocations
  WHERE builder_id = tenant_id
    AND account_id = budget_account_id;

  IF account_row.committed_usd IS DISTINCT FROM expected_committed
     OR account_row.reserved_usd IS DISTINCT FROM expected_reserved
     OR account_row.unresolved_usd IS DISTINCT FROM expected_unresolved THEN
    RAISE EXCEPTION 'budget account counters do not equal retained allocation postings'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pylva_budget_account_postings_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_account_postings(NEW.builder_id, NEW.id);
  RETURN NULL;
END;
$$;

-- These historical-scan triggers existed in early drafts of the ledger. Keep
-- the reconciliation functions above as explicit audit tools, but do not run
-- an O(history) aggregate once or twice for every posting on a hot account.
DROP TRIGGER IF EXISTS budget_accounts_postings_consistency_guard ON budget_accounts;

CREATE OR REPLACE FUNCTION pylva_budget_allocation_postings_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_account_postings(
    NEW.builder_id,
    NEW.account_id
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS budget_reservation_allocations_postings_consistency_guard
  ON budget_reservation_allocations;

CREATE OR REPLACE FUNCTION pylva_budget_outbox_immutability_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  authoritative_now TIMESTAMPTZ;
  usage_row public.budget_usage_ledger%ROWTYPE;
  worker_id TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NULLIF(current_setting('app.builder_id', true), '')::uuid
         IS DISTINCT FROM NEW.builder_id THEN
      RAISE EXCEPTION 'budget-control tenant context does not match outbox tenant'
        USING ERRCODE = '42501';
    END IF;

    NEW.created_at := date_trunc('milliseconds', clock_timestamp());
    NEW.updated_at := NEW.created_at;
    NEW.available_at := NEW.created_at;
    NEW.payload_hash := public.pylva_budget_jsonb_sha256(NEW.payload);
    IF NEW.projection_verified_at IS NOT NULL
       OR NEW.payload_purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'new outbox rows cannot start verified or purged'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status <> 'pending'
       OR NEW.attempts <> 0
       OR NEW.locked_at IS NOT NULL
       OR NEW.lock_expires_at IS NOT NULL
       OR NEW.lock_owner IS NOT NULL
       OR NEW.last_attempt_at IS NOT NULL
       OR NEW.projected_at IS NOT NULL
       OR NEW.last_error_code IS NOT NULL
       OR NEW.last_error_message IS NOT NULL THEN
      RAISE EXCEPTION 'new outbox rows must start pending and unclaimed'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_cost_event_outbox rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.builder_id IS DISTINCT FROM NEW.builder_id
     OR OLD.id IS DISTINCT FROM NEW.id
     OR OLD.usage_ledger_id IS DISTINCT FROM NEW.usage_ledger_id
     OR OLD.cost_event_id IS DISTINCT FROM NEW.cost_event_id
     OR OLD.payload_schema_version IS DISTINCT FROM NEW.payload_schema_version
     OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'budget_cost_event_outbox identity and payload hash are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.payload_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'purged outbox tombstones are immutable'
      USING ERRCODE = '55000';
  END IF;

  -- Reconciliation verification is one-way and server-timestamped. It does
  -- not make any worker lifecycle field mutable after projection.
  IF OLD.projection_verified_at IS NULL
     AND NEW.projection_verified_at IS NOT NULL THEN
    IF OLD.status <> 'projected'
       OR NEW.status <> 'projected'
       OR OLD.payload IS NULL
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.payload_purged_at IS NOT NULL
       OR (to_jsonb(OLD) - ARRAY[
            'projection_verified_at', 'updated_at'
          ]::TEXT[])
            IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY[
            'projection_verified_at', 'updated_at'
          ]::TEXT[]) THEN
      RAISE EXCEPTION 'only a projected payload can become reconciliation-verified'
        USING ERRCODE = '55000';
    END IF;

    NEW.projection_verified_at := date_trunc('milliseconds', clock_timestamp());
    NEW.updated_at := NEW.projection_verified_at;
    RETURN NEW;
  END IF;

  -- Purging removes only the already-verified payload. The usage-side guard
  -- may execute before or after this statement; a deferred pair check makes
  -- the two tombstones atomic at COMMIT.
  IF OLD.payload IS NOT NULL AND NEW.payload IS NULL THEN
    SELECT *
    INTO usage_row
    FROM public.budget_usage_ledger
    WHERE builder_id = OLD.builder_id
      AND id = OLD.usage_ledger_id
      AND cost_event_id = OLD.cost_event_id;

    IF OLD.status <> 'projected'
       OR NEW.status <> 'projected'
       OR OLD.projection_verified_at IS NULL
       OR OLD.projection_verified_at > clock_timestamp()
       OR NEW.projection_verified_at IS DISTINCT FROM OLD.projection_verified_at
       OR NOT FOUND
       OR clock_timestamp() < usage_row.retain_until
       OR (to_jsonb(OLD) - ARRAY[
            'payload', 'payload_purged_at', 'updated_at'
          ]::TEXT[])
            IS DISTINCT FROM
          (to_jsonb(NEW) - ARRAY[
            'payload', 'payload_purged_at', 'updated_at'
          ]::TEXT[]) THEN
      RAISE EXCEPTION 'outbox payload is not eligible for retention purge'
        USING ERRCODE = '55000';
    END IF;

    NEW.payload_purged_at := COALESCE(
      usage_row.details_purged_at,
      date_trunc('milliseconds', clock_timestamp())
    );
    NEW.updated_at := NEW.payload_purged_at;
    RETURN NEW;
  END IF;

  IF NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_purged_at IS DISTINCT FROM OLD.payload_purged_at
     OR NEW.projection_verified_at IS DISTINCT FROM OLD.projection_verified_at THEN
    RAISE EXCEPTION 'outbox payload and retention markers are immutable outside retention transitions'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := date_trunc('milliseconds', clock_timestamp());

  IF NEW.attempts < OLD.attempts
     OR NEW.attempts - OLD.attempts > 1
     OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'outbox attempts and updated_at cannot move backward'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'projected' AND (
    OLD.status IS DISTINCT FROM NEW.status
    OR OLD.attempts IS DISTINCT FROM NEW.attempts
    OR OLD.available_at IS DISTINCT FROM NEW.available_at
    OR OLD.locked_at IS DISTINCT FROM NEW.locked_at
    OR OLD.lock_expires_at IS DISTINCT FROM NEW.lock_expires_at
    OR OLD.lock_owner IS DISTINCT FROM NEW.lock_owner
    OR OLD.last_attempt_at IS DISTINCT FROM NEW.last_attempt_at
    OR OLD.projected_at IS DISTINCT FROM NEW.projected_at
    OR OLD.last_error_code IS DISTINCT FROM NEW.last_error_code
    OR OLD.last_error_message IS DISTINCT FROM NEW.last_error_message
    OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
  ) THEN
    RAISE EXCEPTION 'projected outbox rows are terminal'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'pending' AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('pending', 'projected'))
  ) THEN
    RAISE EXCEPTION 'illegal budget_cost_event_outbox lifecycle transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF (to_jsonb(OLD) - 'updated_at')
         IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at') THEN
      RAISE EXCEPTION 'pending outbox rows may change only when claimed'
        USING ERRCODE = '55000';
    END IF;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  authoritative_now := date_trunc('milliseconds', clock_timestamp());
  worker_id := NULLIF(current_setting('app.outbox_worker_id', true), '');

  IF worker_id IS NOT NULL AND (
    char_length(worker_id) NOT BETWEEN 1 AND 100
    OR worker_id ~ E'[\\u0001-\\u001F\\u007F]'
    OR worker_id ~ E'^[\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$'
  ) THEN
    RAISE EXCEPTION 'app.outbox_worker_id is not a valid worker identity'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status IN ('processing', 'pending', 'projected')
     AND worker_id IS NULL THEN
    RAISE EXCEPTION 'processing an outbox row requires app.outbox_worker_id'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'processing' THEN
    IF worker_id IS NULL THEN
      RAISE EXCEPTION 'claiming an outbox row requires app.outbox_worker_id'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.available_at > authoritative_now THEN
      RAISE EXCEPTION 'outbox row is not available for another attempt yet'
        USING ERRCODE = '55000';
    END IF;
    NEW.available_at := OLD.available_at;
    NEW.locked_at := authoritative_now;
    NEW.lock_expires_at := authoritative_now + INTERVAL '1 minute';
    NEW.lock_owner := worker_id;
    NEW.last_attempt_at := authoritative_now;
    NEW.projected_at := NULL;
    NEW.last_error_code := NULL;
    NEW.last_error_message := NULL;
  ELSIF OLD.status = 'processing' AND NEW.status = 'pending' THEN
    IF authoritative_now < OLD.lock_expires_at
       AND worker_id IS DISTINCT FROM OLD.lock_owner THEN
      RAISE EXCEPTION 'only the active outbox owner may release an unexpired lease'
        USING ERRCODE = '42501';
    END IF;
    NEW.available_at := LEAST(
      GREATEST(NEW.available_at, authoritative_now),
      authoritative_now + INTERVAL '5 minutes'
    );
    NEW.locked_at := NULL;
    NEW.lock_expires_at := NULL;
    NEW.lock_owner := NULL;
    NEW.last_attempt_at := OLD.last_attempt_at;
    NEW.projected_at := NULL;
  ELSIF OLD.status = 'processing' AND NEW.status = 'projected' THEN
    IF worker_id IS DISTINCT FROM OLD.lock_owner
       OR authoritative_now >= OLD.lock_expires_at THEN
      RAISE EXCEPTION 'only the active unexpired outbox owner may project an event'
        USING ERRCODE = '42501';
    END IF;
    NEW.available_at := OLD.available_at;
    NEW.locked_at := NULL;
    NEW.lock_expires_at := NULL;
    NEW.lock_owner := NULL;
    NEW.last_attempt_at := OLD.last_attempt_at;
    NEW.projected_at := authoritative_now;
    NEW.last_error_code := NULL;
    NEW.last_error_message := NULL;
  ELSIF OLD.status = 'processing' AND NEW.status = 'processing' THEN
    IF worker_id IS DISTINCT FROM OLD.lock_owner
       OR authoritative_now >= OLD.lock_expires_at THEN
      RAISE EXCEPTION 'only the active unexpired outbox owner may renew a lease'
        USING ERRCODE = '42501';
    END IF;
    NEW.available_at := OLD.available_at;
    NEW.locked_at := OLD.locked_at;
    NEW.lock_expires_at := LEAST(
      GREATEST(
        authoritative_now + INTERVAL '1 minute',
        OLD.lock_expires_at + INTERVAL '1 millisecond'
      ),
      OLD.locked_at + INTERVAL '5 minutes'
    );
    NEW.lock_owner := OLD.lock_owner;
    NEW.last_attempt_at := OLD.last_attempt_at;
    NEW.last_error_code := OLD.last_error_code;
    NEW.last_error_message := OLD.last_error_message;
  END IF;

  IF NEW.available_at IS DISTINCT FROM OLD.available_at
     AND NOT (OLD.status = 'processing' AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'outbox availability changes only on bounded retry release'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'processing' AND (
    NEW.attempts - OLD.attempts <> 1
    OR NEW.last_attempt_at IS DISTINCT FROM NEW.locked_at
    OR NEW.last_error_code IS NOT NULL
    OR NEW.last_error_message IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'claiming an outbox row must start exactly one clean attempt'
      USING ERRCODE = '55000';
  ELSIF OLD.status = 'processing'
        AND NEW.status IN ('pending', 'projected')
        AND NEW.attempts IS DISTINCT FROM OLD.attempts THEN
    RAISE EXCEPTION 'finishing an outbox attempt cannot increment attempts again'
      USING ERRCODE = '55000';
  ELSIF OLD.status IS NOT DISTINCT FROM NEW.status
        AND NEW.attempts IS DISTINCT FROM OLD.attempts THEN
    RAISE EXCEPTION 'outbox attempts increment only when a pending row is claimed'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status = 'processing'
     AND (
       NEW.lock_owner IS DISTINCT FROM OLD.lock_owner
       OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
       OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at
       OR NEW.lock_expires_at <= OLD.lock_expires_at
     ) THEN
    RAISE EXCEPTION 'an active outbox lease renewal must preserve identity and advance expiry'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS budget_cost_event_outbox_immutability_guard
  ON budget_cost_event_outbox;
CREATE TRIGGER budget_cost_event_outbox_immutability_guard
BEFORE INSERT OR UPDATE OR DELETE ON budget_cost_event_outbox
FOR EACH ROW EXECUTE FUNCTION pylva_budget_outbox_immutability_guard();

COMMENT ON TABLE budget_accounts IS
  'Authoritative budget accumulators. Lock rows in deterministic primary-key order.';
COMMENT ON COLUMN budget_accounts.enforcement IS
  'Immutable origin revision value; current policy must join the active budget_rule_revisions row.';
COMMENT ON COLUMN budget_accounts.limit_usd IS
  'Immutable origin revision value; current policy must join the active budget_rule_revisions row.';
COMMENT ON TABLE budget_rule_revisions IS
  'Immutable global rule configuration history over stable budget accumulators.';
COMMENT ON TABLE budget_reservations IS
  'Idempotent reserve decisions and their current authoritative lifecycle state.';
COMMENT ON TABLE budget_reservation_allocations IS
  'Per-account decision and settlement arithmetic for each reservation.';
COMMENT ON TABLE budget_reservation_transitions IS
  'Append-only lifecycle idempotency and audit records.';
COMMENT ON TABLE budget_usage_ledger IS
  'Append-only authoritative committed usage and billing source.';
COMMENT ON TABLE budget_cost_event_outbox IS
  'Durable retry-until-projected ClickHouse cost-event outbox.';
