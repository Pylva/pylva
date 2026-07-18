-- 051: Runtime readiness and opening-balance evidence for authoritative
-- budget control.
--
-- Migration 050 defines the immutable authority ledger. This additive layer
-- proves when each builder may use that ledger as a truthful control plane:
--   * next_period waits for the latest next UTC boundary across active rules;
--   * exact_backfill records a reconciled cutover watermark; and
--   * every account is paired with immutable, canonical opening evidence.
--
-- The builder advisory-lock seed is intentionally identical to migration 050.
-- Readiness, rule changes, account materialization, evidence insertion, and
-- reservation authorization therefore have one strict builder-scoped order.

DO $$
DECLARE
  tenant RECORD;
  previous_tenant TEXT := current_setting('app.builder_id', true);
BEGIN
  -- budget_accounts already has forced RLS. Walk the unscoped parent table and
  -- enter each tenant context so no pre-051 account can be silently
  -- grandfathered without evidence.
  FOR tenant IN SELECT id FROM public.builders LOOP
    PERFORM set_config('app.builder_id', tenant.id::TEXT, true);
    IF EXISTS (
      SELECT 1
      FROM public.budget_accounts account
      WHERE account.builder_id = tenant.id
    ) THEN
      RAISE EXCEPTION
        'migration 051 requires an empty pre-roll budget_accounts table; existing accounts have no opening evidence'
        USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.budget_reservations reservation
      WHERE reservation.builder_id = tenant.id
        AND (
          reservation.decision IN ('reserved', 'denied')
          OR (
            reservation.decision = 'bypassed'
            AND reservation.decision_reason IN (
              'no_applicable_budget',
              'shadow_would_allow',
              'shadow_would_deny'
            )
          )
        )
    ) THEN
      RAISE EXCEPTION
        'migration 051 cannot grandfather evaluated budget decisions without typed readiness'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  PERFORM set_config('app.builder_id', COALESCE(previous_tenant, ''), true);
END;
$$;

-------------------------------------------------------------------
-- D049: retain provider-reported post-call costs without overflowing the
-- public reservation estimate range. Only actual/overage evidence widens.
-------------------------------------------------------------------
ALTER TABLE public.budget_reservations
  ALTER COLUMN actual_usd TYPE NUMERIC(44,18),
  ALTER COLUMN overage_usd TYPE NUMERIC(44,18);

ALTER TABLE public.budget_reservation_allocations
  ALTER COLUMN actual_usd TYPE NUMERIC(44,18),
  ALTER COLUMN overage_usd TYPE NUMERIC(44,18);

ALTER TABLE public.budget_usage_ledger
  ALTER COLUMN actual_cost_usd TYPE NUMERIC(44,18);

-------------------------------------------------------------------
-- D047: a shadow request may fail to reach the control authority. Persist the
-- bypass without inventing pricing, a requested amount, or an evaluation.
-- Existing allocation guards already reject allocations for this reason.
-------------------------------------------------------------------
ALTER TABLE public.budget_reservations
  DROP CONSTRAINT budget_reservations_decision_reason_ck;
ALTER TABLE public.budget_reservations
  ADD CONSTRAINT budget_reservations_decision_reason_ck
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
          WHEN 'shadow_control_unavailable' THEN
            mode = 'shadow' AND would_have_denied IS NULL
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
  );

ALTER TABLE public.budget_reservations
  DROP CONSTRAINT budget_reservations_decision_state_ck;
ALTER TABLE public.budget_reservations
  ADD CONSTRAINT budget_reservations_decision_state_ck
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
        AND (
          decision_reason IS DISTINCT FROM 'shadow_control_unavailable'
          OR (
            pricing_snapshot IS NULL
            AND pricing_snapshot_hash IS NULL
            AND requested_usd IS NULL
            AND remaining_usd IS NULL
            AND deciding_account_id IS NULL
          )
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
  );

-------------------------------------------------------------------
-- D050: a durable per-change ordering marker distinguishes stable rules that
-- existed before the readiness fence from rules created after it. Timestamps
-- cannot provide that proof because both sides intentionally use millisecond
-- wire precision. The sequence has no PUBLIC privilege; the current migration
-- and runtime owner has implicit access, while a future non-owner runtime role
-- must receive explicit USAGE as part of its role provisioning.
--
-- Existing revisions are backfilled before any cutover row can exist. Future
-- values are always allocated only after the frozen exclusive builder lock is
-- held. Sequence gaps caused by transaction rollback are harmless.
-------------------------------------------------------------------
CREATE SEQUENCE public.pylva_budget_authority_order_seq
  AS BIGINT
  MINVALUE 1
  MAXVALUE 9223372036854775806
  NO CYCLE;

REVOKE ALL ON SEQUENCE public.pylva_budget_authority_order_seq FROM PUBLIC;

ALTER TABLE public.budget_rule_revisions
  ADD COLUMN authority_order BIGINT NOT NULL
    DEFAULT pg_catalog.nextval('public.pylva_budget_authority_order_seq'::REGCLASS);

ALTER TABLE public.budget_rule_revisions
  ALTER COLUMN authority_order DROP DEFAULT,
  ADD CONSTRAINT budget_rule_revisions_authority_order_uk
    UNIQUE (authority_order),
  ADD CONSTRAINT budget_rule_revisions_authority_order_ck
    CHECK (authority_order BETWEEN 1 AND 9223372036854775806);

CREATE OR REPLACE FUNCTION public.pylva_budget_rule_revision_authority_order_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM NEW.builder_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match rule revision tenant'
      USING ERRCODE = '42501';
  END IF;

  -- Re-acquiring the same transaction lock is intentional and makes the
  -- ordering guarantee independent of PostgreSQL's alphabetical trigger order.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.builder_id::TEXT, 50620260714)
  );
  NEW.authority_order := pg_catalog.nextval(
    'public.pylva_budget_authority_order_seq'::REGCLASS
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_rule_revisions_authority_order_guard
BEFORE INSERT ON public.budget_rule_revisions
FOR EACH ROW
EXECUTE FUNCTION public.pylva_budget_rule_revision_authority_order_guard();

-------------------------------------------------------------------
-- UTC period-boundary helpers. These are pinned to trusted schemas because
-- they participate in authorization readiness.
-------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pylva_budget_next_period_boundary(
  period_name TEXT,
  reference_time TIMESTAMPTZ
)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE period_name
    WHEN 'hour' THEN
      date_trunc('hour', reference_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        + INTERVAL '1 hour'
    WHEN 'day' THEN
      date_trunc('day', reference_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        + INTERVAL '1 day'
    WHEN 'week' THEN
      date_trunc('week', reference_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        + INTERVAL '7 days'
    WHEN 'month' THEN
      (
        date_trunc('month', reference_time AT TIME ZONE 'UTC')
          + INTERVAL '1 month'
      ) AT TIME ZONE 'UTC'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION public.pylva_budget_builder_next_activation_boundary(
  tenant_id UUID,
  activation_anchor TIMESTAMPTZ
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  result TIMESTAMPTZ;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match cutover tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    MAX(public.pylva_budget_next_period_boundary(
      revision.period,
      GREATEST(revision.active_from, activation_anchor)
    )),
    activation_anchor
  )
  INTO result
  FROM public.budget_rule_revisions revision
  WHERE revision.builder_id = tenant_id
    AND revision.retired_at IS NULL;

  RETURN result;
END;
$$;

-------------------------------------------------------------------
-- One typed, durable readiness authority per builder.
-------------------------------------------------------------------
CREATE TABLE public.budget_control_cutovers (
  builder_id                    UUID PRIMARY KEY
    REFERENCES public.builders(id) ON DELETE RESTRICT,
  status                        VARCHAR(20) NOT NULL DEFAULT 'pending',
  mode                          VARCHAR(20) NOT NULL,
  cutover_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reconciled_through            TIMESTAMPTZ,
  reconciliation_snapshot       JSONB,
  reconciliation_snapshot_hash CHAR(64),
  ready_at                      TIMESTAMPTZ,
  ready_order                   BIGINT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_control_cutovers_status_ck
    CHECK (status IN ('pending', 'ready')),
  CONSTRAINT budget_control_cutovers_mode_ck
    CHECK (mode IN ('next_period', 'exact_backfill')),
  CONSTRAINT budget_control_cutovers_lifecycle_ck
    CHECK (
      (
        status = 'pending'
        AND reconciled_through IS NULL
        AND reconciliation_snapshot IS NULL
        AND reconciliation_snapshot_hash IS NULL
        AND ready_at IS NULL
        AND ready_order IS NULL
      )
      OR
      (
        status = 'ready'
        AND ready_at IS NOT NULL
        AND ready_order IS NOT NULL
        AND ready_at >= cutover_at
        AND (
          (
            mode = 'next_period'
            AND reconciled_through IS NULL
            AND reconciliation_snapshot IS NULL
            AND reconciliation_snapshot_hash IS NULL
          )
          OR
          (
            mode = 'exact_backfill'
            AND reconciled_through IS NOT DISTINCT FROM cutover_at
            AND reconciliation_snapshot IS NOT NULL
            AND reconciliation_snapshot_hash IS NOT NULL
          )
        )
      )
    ),
  CONSTRAINT budget_control_cutovers_ready_order_ck
    CHECK (
      (status = 'pending' AND ready_order IS NULL)
      OR
      (
        status = 'ready'
        AND ready_order BETWEEN 1 AND 9223372036854775806
      )
    ),
  CONSTRAINT budget_control_cutovers_reconciliation_ck
    CHECK (
      reconciliation_snapshot IS NULL
      OR (
        jsonb_typeof(reconciliation_snapshot) IS NOT DISTINCT FROM 'object'
        AND reconciliation_snapshot = jsonb_build_object(
          'schema_version', '1.0',
          'builder_id', builder_id::TEXT,
          'mode', 'exact_backfill',
          'cutover_at', public.pylva_budget_timestamp_text(cutover_at),
          'reconciled_through',
            public.pylva_budget_timestamp_text(reconciled_through)
        )
        AND reconciliation_snapshot_hash ~ '^[0-9a-f]{64}$'
        AND reconciliation_snapshot_hash =
          public.pylva_budget_jsonb_sha256(reconciliation_snapshot)
      )
    ),
  CONSTRAINT budget_control_cutovers_timestamps_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(cutover_at)
      AND public.pylva_budget_timestamp_is_wire_safe(created_at)
      AND public.pylva_budget_timestamp_is_wire_safe(updated_at)
      AND updated_at >= created_at
      AND (
        reconciled_through IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(reconciled_through)
      )
      AND (
        ready_at IS NULL
        OR public.pylva_budget_timestamp_is_wire_safe(ready_at)
      )
    )
);

CREATE OR REPLACE FUNCTION public.pylva_budget_cutovers_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  authoritative_now TIMESTAMPTZ;
  activation_boundary TIMESTAMPTZ;
  tenant_id UUID;
BEGIN
  tenant_id := COALESCE(NEW.builder_id, OLD.builder_id);

  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match cutover tenant'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'budget_control_cutovers rows are immutable and cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.budget_reservations reservation
    WHERE reservation.builder_id = tenant_id
      AND reservation.authorization_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'cutover readiness cannot change after a reservation in the same transaction'
      USING ERRCODE = '25001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant_id::TEXT, 50620260714)
  );
  authoritative_now := date_trunc('milliseconds', clock_timestamp());

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'new budget-control cutovers must start pending'
        USING ERRCODE = '23514';
    END IF;

    NEW.created_at := authoritative_now;
    NEW.updated_at := authoritative_now;
    NEW.ready_at := NULL;
    NEW.ready_order := NULL;
    NEW.reconciled_through := NULL;
    NEW.reconciliation_snapshot := NULL;
    NEW.reconciliation_snapshot_hash := NULL;

    IF NEW.mode = 'next_period' THEN
      NEW.cutover_at := public.pylva_budget_builder_next_activation_boundary(
        NEW.builder_id,
        authoritative_now
      );
    ELSE
      NEW.cutover_at := authoritative_now;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ready' THEN
    RAISE EXCEPTION 'ready budget-control cutovers are immutable and cannot be reversed'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.builder_id IS DISTINCT FROM NEW.builder_id
     OR OLD.mode IS DISTINCT FROM NEW.mode
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'budget-control cutover identity and mode are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'pending' THEN
    IF (
      to_jsonb(OLD) - ARRAY['cutover_at', 'updated_at']::TEXT[]
    ) IS DISTINCT FROM (
      to_jsonb(NEW) - ARRAY['cutover_at', 'updated_at']::TEXT[]
    ) THEN
      RAISE EXCEPTION 'pending cutovers permit only a monotonic boundary refresh'
        USING ERRCODE = '55000';
    END IF;

    IF OLD.mode = 'exact_backfill' THEN
      NEW.cutover_at := OLD.cutover_at;
      NEW.updated_at := OLD.updated_at;
      RETURN NEW;
    END IF;

    activation_boundary := public.pylva_budget_builder_next_activation_boundary(
      NEW.builder_id,
      OLD.created_at
    );
    NEW.cutover_at := GREATEST(OLD.cutover_at, activation_boundary);
    NEW.updated_at := CASE
      WHEN NEW.cutover_at > OLD.cutover_at THEN authoritative_now
      ELSE OLD.updated_at
    END;
    RETURN NEW;
  END IF;

  IF NEW.status <> 'ready' THEN
    RAISE EXCEPTION 'pending cutovers permit only a one-way transition to ready'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.mode = 'next_period' THEN
    activation_boundary := public.pylva_budget_builder_next_activation_boundary(
      NEW.builder_id,
      OLD.created_at
    );
    NEW.cutover_at := GREATEST(OLD.cutover_at, activation_boundary);
    IF authoritative_now < NEW.cutover_at THEN
      RAISE EXCEPTION 'next-period cutover cannot become ready before its activation boundary'
        USING ERRCODE = '55000';
    END IF;
    NEW.reconciled_through := NULL;
    NEW.reconciliation_snapshot := NULL;
    NEW.reconciliation_snapshot_hash := NULL;
  ELSE
    NEW.cutover_at := OLD.cutover_at;
    IF NEW.reconciled_through IS DISTINCT FROM OLD.cutover_at THEN
      RAISE EXCEPTION 'exact backfill must reconcile through the immutable cutover watermark'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  NEW.ready_at := authoritative_now;
  NEW.ready_order := pg_catalog.nextval(
    'public.pylva_budget_authority_order_seq'::REGCLASS
  );
  NEW.updated_at := authoritative_now;
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_control_cutovers_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.budget_control_cutovers
FOR EACH ROW EXECUTE FUNCTION public.pylva_budget_cutovers_guard();

-------------------------------------------------------------------
-- D050: evaluated decisions are valid only after this builder's typed
-- readiness authority existed. Unavailable and unevaluated bypass outcomes
-- remain persistable so a missing readiness row can fail honestly rather than
-- being mislabeled as an evaluated no-budget result.
-------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pylva_budget_assert_reservation_readiness(
  tenant_id UUID,
  reservation_decision UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  reservation_row public.budget_reservations%ROWTYPE;
  cutover_row public.budget_control_cutovers%ROWTYPE;
  requires_readiness BOOLEAN;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match reservation tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO reservation_row
  FROM public.budget_reservations
  WHERE builder_id = tenant_id AND decision_id = reservation_decision;

  IF reservation_row.decision_id IS NULL THEN
    RAISE EXCEPTION 'reservation readiness check has no matching decision'
      USING ERRCODE = '23503';
  END IF;

  requires_readiness :=
    reservation_row.decision IN ('reserved', 'denied')
    OR (
      reservation_row.decision = 'bypassed'
      AND reservation_row.decision_reason IN (
        'no_applicable_budget',
        'shadow_would_allow',
        'shadow_would_deny'
      )
    );

  IF NOT requires_readiness THEN
    RETURN;
  END IF;

  SELECT *
  INTO cutover_row
  FROM public.budget_control_cutovers
  WHERE builder_id = tenant_id;

  IF cutover_row.builder_id IS NULL
     OR cutover_row.status <> 'ready'
     OR cutover_row.ready_at IS NULL
     OR cutover_row.ready_at > reservation_row.created_at THEN
    RAISE EXCEPTION
      'evaluated budget decisions require a ready authoritative cutover'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pylva_budget_reservation_readiness_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_reservation_readiness(
    NEW.builder_id,
    NEW.decision_id
  );
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER budget_reservations_readiness_consistency_guard
AFTER INSERT ON public.budget_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.pylva_budget_reservation_readiness_consistency_guard();

-------------------------------------------------------------------
-- Immutable proof for every account's initial committed balance.
-------------------------------------------------------------------
CREATE TABLE public.budget_account_opening_evidence (
  builder_id                    UUID NOT NULL,
  account_id                    UUID NOT NULL,
  source                        VARCHAR(30) NOT NULL,
  opening_committed_usd         NUMERIC(38,18) NOT NULL,
  measured_through              TIMESTAMPTZ NOT NULL,
  evidence_snapshot             JSONB NOT NULL,
  evidence_snapshot_hash        CHAR(64) NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT budget_account_opening_evidence_pk
    PRIMARY KEY (builder_id, account_id),
  CONSTRAINT budget_account_opening_evidence_cutover_fk
    FOREIGN KEY (builder_id)
    REFERENCES public.budget_control_cutovers(builder_id) ON DELETE RESTRICT,
  CONSTRAINT budget_account_opening_evidence_account_fk
    FOREIGN KEY (builder_id, account_id)
    REFERENCES public.budget_accounts(builder_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT budget_account_opening_evidence_source_ck
    CHECK (source IN ('post_cutover_zero', 'exact_backfill')),
  CONSTRAINT budget_account_opening_evidence_amount_ck
    CHECK (
      opening_committed_usd <> 'NaN'::numeric
      AND opening_committed_usd >= 0
    ),
  CONSTRAINT budget_account_opening_evidence_snapshot_ck
    CHECK (
      jsonb_typeof(evidence_snapshot) IS NOT DISTINCT FROM 'object'
      AND evidence_snapshot_hash ~ '^[0-9a-f]{64}$'
      AND evidence_snapshot_hash =
        public.pylva_budget_jsonb_sha256(evidence_snapshot)
    ),
  CONSTRAINT budget_account_opening_evidence_timestamps_ck
    CHECK (
      public.pylva_budget_timestamp_is_wire_safe(measured_through)
      AND public.pylva_budget_timestamp_is_wire_safe(created_at)
    )
);

CREATE OR REPLACE FUNCTION public.pylva_budget_opening_evidence_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  tenant_id UUID;
BEGIN
  tenant_id := COALESCE(NEW.builder_id, OLD.builder_id);

  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match opening evidence tenant'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'budget_account_opening_evidence rows are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.budget_reservations reservation
    WHERE reservation.builder_id = tenant_id
      AND reservation.authorization_transaction_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'opening evidence must be recorded before reservations in the same transaction'
      USING ERRCODE = '25001';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(tenant_id::TEXT, 50620260714)
  );
  NEW.created_at := date_trunc('milliseconds', clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE TRIGGER budget_account_opening_evidence_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.budget_account_opening_evidence
FOR EACH ROW EXECUTE FUNCTION public.pylva_budget_opening_evidence_guard();

CREATE OR REPLACE FUNCTION public.pylva_budget_assert_account_opening_evidence(
  tenant_id UUID,
  stable_account_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  account_row public.budget_accounts%ROWTYPE;
  cutover_row public.budget_control_cutovers%ROWTYPE;
  evidence_row public.budget_account_opening_evidence%ROWTYPE;
  origin_revision_row public.budget_rule_revisions%ROWTYPE;
  expected_snapshot JSONB;
BEGIN
  IF NULLIF(current_setting('app.builder_id', true), '')::UUID
       IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'budget-control tenant context does not match opening evidence tenant'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO account_row
  FROM public.budget_accounts
  WHERE builder_id = tenant_id AND id = stable_account_id;

  SELECT *
  INTO evidence_row
  FROM public.budget_account_opening_evidence
  WHERE builder_id = tenant_id AND account_id = stable_account_id;

  SELECT *
  INTO cutover_row
  FROM public.budget_control_cutovers
  WHERE builder_id = tenant_id;

  SELECT *
  INTO origin_revision_row
  FROM public.budget_rule_revisions
  WHERE builder_id = tenant_id
    AND rule_key = account_row.rule_key
    AND revision = 0;

  IF account_row.id IS NULL OR evidence_row.account_id IS NULL THEN
    RAISE EXCEPTION 'every budget account requires exactly one opening-evidence row'
      USING ERRCODE = '23514';
  END IF;
  IF cutover_row.builder_id IS NULL OR cutover_row.status <> 'ready' THEN
    RAISE EXCEPTION 'budget accounts require a ready authoritative cutover'
      USING ERRCODE = '23514';
  END IF;
  IF evidence_row.opening_committed_usd
       IS DISTINCT FROM account_row.opening_committed_usd
     OR evidence_row.measured_through IS DISTINCT FROM cutover_row.cutover_at THEN
    RAISE EXCEPTION 'opening evidence amount or watermark does not match its account cutover'
      USING ERRCODE = '23514';
  END IF;

  IF evidence_row.source = 'post_cutover_zero' THEN
    IF account_row.opening_committed_usd <> 0
       OR NOT (
         account_row.period_start >= cutover_row.cutover_at
         OR (
           origin_revision_row.id IS NOT NULL
           AND origin_revision_row.authority_order > cutover_row.ready_order
         )
       ) THEN
      RAISE EXCEPTION 'post-cutover accounts require an explicit zero opening at or after cutover'
        USING ERRCODE = '23514';
    END IF;
  ELSIF evidence_row.source = 'exact_backfill' THEN
    IF cutover_row.mode <> 'exact_backfill'
       OR account_row.period_start >= cutover_row.cutover_at
       OR account_row.period_end <= cutover_row.cutover_at THEN
      RAISE EXCEPTION 'exact opening evidence is limited to periods straddling an exact-backfill cutover'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown account opening-evidence source'
      USING ERRCODE = '23514';
  END IF;

  expected_snapshot := jsonb_build_object(
    'schema_version', '1.0',
    'source', evidence_row.source,
    'builder_id', tenant_id::TEXT,
    'account_id', stable_account_id::TEXT,
    'rule_key', account_row.rule_key::TEXT,
    'scope', account_row.scope,
    'subject_customer_id', account_row.subject_customer_id,
    'period', account_row.period,
    'period_start', public.pylva_budget_timestamp_text(account_row.period_start),
    'period_end', public.pylva_budget_timestamp_text(account_row.period_end),
    'cutover_at', public.pylva_budget_timestamp_text(cutover_row.cutover_at),
    'measured_through',
      public.pylva_budget_timestamp_text(evidence_row.measured_through),
    'opening_committed_usd',
      public.pylva_budget_decimal_text(evidence_row.opening_committed_usd)
  );

  IF evidence_row.evidence_snapshot IS DISTINCT FROM expected_snapshot
     OR evidence_row.evidence_snapshot_hash IS DISTINCT FROM
       public.pylva_budget_jsonb_sha256(expected_snapshot) THEN
    RAISE EXCEPTION 'account opening-evidence snapshot is not canonical'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pylva_budget_account_opening_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_account_opening_evidence(
    NEW.builder_id,
    NEW.id
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.pylva_budget_opening_evidence_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.pylva_budget_assert_account_opening_evidence(
    NEW.builder_id,
    NEW.account_id
  );
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER budget_accounts_opening_evidence_consistency_guard
AFTER INSERT ON public.budget_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.pylva_budget_account_opening_consistency_guard();

CREATE CONSTRAINT TRIGGER budget_account_opening_evidence_consistency_guard
AFTER INSERT ON public.budget_account_opening_evidence
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.pylva_budget_opening_evidence_consistency_guard();

-- Callers must always state the opening balance; omitting it is no longer a
-- silent assertion that legacy committed spend was zero.
ALTER TABLE public.budget_accounts
  ALTER COLUMN opening_committed_usd DROP DEFAULT;

-------------------------------------------------------------------
-- Forced tenant isolation for both new authorities.
-------------------------------------------------------------------
ALTER TABLE public.budget_control_cutovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_control_cutovers FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_control_cutovers_isolation
  ON public.budget_control_cutovers
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::UUID)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::UUID);

ALTER TABLE public.budget_account_opening_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_account_opening_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_account_opening_evidence_isolation
  ON public.budget_account_opening_evidence
  FOR ALL
  USING (builder_id = current_setting('app.builder_id', true)::UUID)
  WITH CHECK (builder_id = current_setting('app.builder_id', true)::UUID);

COMMENT ON TABLE public.budget_control_cutovers IS
  'Builder-level PostgreSQL authority for one-way all-cost-control readiness.';
COMMENT ON COLUMN public.budget_control_cutovers.cutover_at IS
  'Immutable exact-backfill watermark or monotonic next-period activation boundary.';
COMMENT ON TABLE public.budget_account_opening_evidence IS
  'Immutable canonical proof of every authoritative budget account opening balance.';
