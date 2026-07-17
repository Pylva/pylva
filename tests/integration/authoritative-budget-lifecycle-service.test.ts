import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/db/client.js', () => ({
  sql: { begin: vi.fn() },
}));

import {
  BudgetLifecycleError,
  BudgetLifecycleSchemaBlockerError,
  createBudgetLifecycleService,
  type BudgetLifecycleService,
} from '../../src/lib/budget-control/lifecycle-service.js';
import { acquireBudgetBuilderExclusiveLock } from '../../src/lib/budget-control/transaction.js';
import {
  createBudgetProjectionPostgresStore,
  createBudgetProjectionWorkerId,
  type BudgetProjectionPostgresStore,
} from '../../src/lib/budget-projection/postgres.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const SDK_IDENTITY = { sdkVersion: '1.2.0', sdkLanguage: 'typescript' as const };
const PAST_RESERVED_AT = '2020-01-01T00:00:00.000Z';
const PAST_EXPIRES_AT = '2020-01-01T00:05:00.000Z';
const BOUNDARY_LEASE_MILLISECONDS = 1_000;

interface HeldFixture {
  accountId: string;
  builderId: string;
  decisionId: string;
  operationId: string;
  reservationId: string;
  requestedUsd: string;
}

interface SeedOptions {
  kind?: 'llm' | 'tool';
  limitUsd?: string;
  requestedUsd?: string;
  toolMaximumValue?: string;
  toolPricingTiers?: Array<{
    from: string;
    price_per_unit_usd: string;
    to: string | null;
  }>;
  toolUnitCostUsd?: string;
}

let scratch: ScratchDb | undefined;
let service: BudgetLifecycleService;
let raceClient: Sql | undefined;
let raceService: BudgetLifecycleService;
let projectionStore: BudgetProjectionPostgresStore;
let raceProjectionStore: BudgetProjectionPostgresStore;

const BILLING_BARRIER_TEST_LOCK = 745_221;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectStillPending<T>(promise: Promise<T>, milliseconds = 75): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'settled' as const),
    delay(milliseconds).then(() => 'pending' as const),
  ]);
  expect(outcome).toBe('pending');
}

async function waitForAdvisoryWait(key: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await raceClient!<{ waiting: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_locks AS lock
        WHERE lock.locktype = 'advisory'
          AND lock.database = (
            SELECT database.oid
            FROM pg_catalog.pg_database AS database
            WHERE database.datname = pg_catalog.current_database()
          )
          AND lock.classid = 0
          AND lock.objid = ${key}
          AND lock.objsubid = 1
          AND NOT lock.granted
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for advisory lock ${key}`);
}

function db(): Sql {
  if (!scratch) throw new Error('lifecycle scratch database is unavailable');
  return scratch.sql;
}

async function useBuilder(transaction: TransactionSql, builderId: string): Promise<void> {
  await transaction`
    SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
  `;
}

async function jsonHash(transaction: TransactionSql, value: postgres.JSONValue): Promise<string> {
  const rows = await transaction<{ value: string }[]>`
    SELECT public.pylva_budget_jsonb_sha256(${transaction.json(value)}::JSONB) AS value
  `;
  const hash = rows[0]?.value;
  if (!hash) throw new Error('fixture JSON hash failed');
  return hash;
}

async function insertBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const rows = await db()<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (
      ${`${label}-${suffix}@example.com`}, ${label}, 'pro', ${`${label}-${suffix}`}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('builder fixture insert failed');
  return id;
}

async function seedHeldReservation(
  builderId: string,
  options: SeedOptions = {},
): Promise<HeldFixture> {
  const kind = options.kind ?? 'tool';
  const requestedUsd = options.requestedUsd ?? '1';
  const limitUsd = options.limitUsd ?? '1000';
  const toolMaximumValue = options.toolMaximumValue ?? requestedUsd;
  const toolUnitCostUsd = options.toolUnitCostUsd ?? '1';

  return db().begin('isolation level read committed', async (transaction) => {
    await useBuilder(transaction, builderId);
    const ruleKey = crypto.randomUUID();
    const ruleRevisionId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    let cutoverRows = await transaction<{ cutover_at: string }[]>`
      SELECT public.pylva_budget_timestamp_text(cutover_at) AS cutover_at
      FROM public.budget_control_cutovers
      WHERE builder_id = ${builderId}::UUID
    `;
    const cutoverWasInserted = cutoverRows.length === 0;
    if (cutoverWasInserted) {
      cutoverRows = await transaction<{ cutover_at: string }[]>`
        INSERT INTO public.budget_control_cutovers (builder_id, status, mode)
        VALUES (${builderId}::UUID, 'pending', 'exact_backfill')
        RETURNING public.pylva_budget_timestamp_text(cutover_at) AS cutover_at
      `;
    }
    const cutoverAt = cutoverRows[0]?.cutover_at;
    if (!cutoverAt) throw new Error('fixture cutover insert failed');
    const reconciliationSnapshot = {
      schema_version: '1.0',
      builder_id: builderId,
      mode: 'exact_backfill',
      cutover_at: cutoverAt,
      reconciled_through: cutoverAt,
    };
    const reconciliationHash = await jsonHash(transaction, reconciliationSnapshot);
    if (cutoverWasInserted) {
      await transaction`
        UPDATE public.budget_control_cutovers
        SET status = 'ready',
            reconciled_through = ${cutoverAt}::TIMESTAMPTZ,
            reconciliation_snapshot = ${transaction.json(reconciliationSnapshot)}::JSONB,
            reconciliation_snapshot_hash = ${reconciliationHash}
        WHERE builder_id = ${builderId}::UUID
      `;
    }
    const configSnapshot = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'hard_stop',
      limit_usd: limitUsd,
    };
    const configHash = await jsonHash(transaction, configSnapshot);
    await transaction`
      INSERT INTO public.budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${ruleRevisionId}::UUID, ${ruleKey}::UUID, 0,
        'pooled', NULL, 'day', 'hard_stop', ${limitUsd}::NUMERIC,
        ${transaction.json(configSnapshot)}::JSONB, ${configHash}
      )
    `;

    const periodRows = await transaction<
      { period_end: string; period_start: string; remaining_usd: string }[]
    >`
      WITH bounds AS (
        SELECT date_trunc('day', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')
                 AT TIME ZONE 'UTC' AS period_start
      )
      SELECT public.pylva_budget_timestamp_text(period_start) AS period_start,
             public.pylva_budget_timestamp_text(period_start + INTERVAL '1 day') AS period_end,
             public.pylva_budget_decimal_text(
               ${limitUsd}::NUMERIC - ${requestedUsd}::NUMERIC
             ) AS remaining_usd
      FROM bounds
    `;
    const period = periodRows[0];
    if (!period) throw new Error('fixture period calculation failed');
    const accountSnapshot = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      subject_customer_id: null,
      period: 'day',
      period_start: period.period_start,
      period_end: period.period_end,
      enforcement: 'hard_stop',
      limit_usd: limitUsd,
      opening_committed_usd: '0',
    };
    const accountHash = await jsonHash(transaction, accountSnapshot);
    await transaction`
      INSERT INTO public.budget_accounts (
        builder_id, id, rule_key, enforcement, limit_usd, scope,
        subject_customer_id, period, period_start, period_end,
        initial_rule_revision_id, initial_rule_snapshot, initial_rule_snapshot_hash,
        opening_committed_usd, committed_usd, reserved_usd, unresolved_usd
      )
      VALUES (
        ${builderId}::UUID, ${accountId}::UUID, ${ruleKey}::UUID,
        'hard_stop', ${limitUsd}::NUMERIC, 'pooled', NULL, 'day',
        ${period.period_start}::TIMESTAMPTZ, ${period.period_end}::TIMESTAMPTZ,
        ${ruleRevisionId}::UUID, ${transaction.json(accountSnapshot)}::JSONB,
        ${accountHash}, 0, 0, 0, 0
      )
    `;
    const evidenceSnapshot = {
      schema_version: '1.0',
      source: 'exact_backfill',
      builder_id: builderId,
      account_id: accountId,
      rule_key: ruleKey,
      scope: 'pooled',
      subject_customer_id: null,
      period: 'day',
      period_start: period.period_start,
      period_end: period.period_end,
      cutover_at: cutoverAt,
      measured_through: cutoverAt,
      opening_committed_usd: '0',
    };
    const evidenceHash = await jsonHash(transaction, evidenceSnapshot);
    await transaction`
      INSERT INTO public.budget_account_opening_evidence (
        builder_id, account_id, source, opening_committed_usd,
        measured_through, evidence_snapshot, evidence_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${accountId}::UUID, 'exact_backfill', 0,
        ${cutoverAt}::TIMESTAMPTZ, ${transaction.json(evidenceSnapshot)}::JSONB,
        ${evidenceHash}
      )
    `;

    const requestSnapshot =
      kind === 'llm'
        ? {
            schema_version: '1.0',
            mode: 'enforce',
            operation_id: operationId,
            customer_id: 'customer_1',
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: null,
            step_name: 'agent.call',
            framework: 'none',
            reservation_ttl_seconds: 300,
            kind: 'llm',
            provider: 'openai',
            model: 'gpt-4o-mini',
            estimated_input_tokens: 100,
            max_output_tokens: 50,
          }
        : {
            schema_version: '1.0',
            mode: 'enforce',
            operation_id: operationId,
            customer_id: 'customer_1',
            trace_id: traceId,
            span_id: spanId,
            parent_span_id: null,
            step_name: 'agent.call',
            framework: 'none',
            reservation_ttl_seconds: 300,
            kind: 'tool',
            cost_source_slug: 'tavily-search',
            tool_name: 'tavily_search',
            metric: 'credit',
            maximum_value: toolMaximumValue,
          };
    const requestHash = await jsonHash(transaction, requestSnapshot);
    const pricingId = crypto.randomUUID();
    const pricingSnapshot =
      kind === 'llm'
        ? {
            schema_version: '1.0',
            kind: 'llm',
            source: 'custom_pricing',
            pricing_id: pricingId,
            source_detail: 'builder_manual',
            provider: 'openai',
            model: 'gpt-4o-mini',
            pricing_model: 'per_million_tokens',
            input_per_million_usd: '0.15',
            output_per_million_usd: '0.6',
            effective_from: '2020-01-01T00:00:00.000Z',
            effective_to: null,
          }
        : options.toolPricingTiers
          ? {
              schema_version: '1.0',
              kind: 'tool',
              source: 'cost_sources',
              pricing_id: pricingId,
              source_type: 'non_llm_manual',
              tracking_status: 'tracked',
              source_status: 'healthy',
              cost_source_slug: 'tavily-search',
              metric: 'credit',
              unit: 'credit',
              approved_at: '2020-01-01T00:00:00.000Z',
              pricing_model: 'volume',
              tiers: options.toolPricingTiers,
            }
          : {
              schema_version: '1.0',
              kind: 'tool',
              source: 'cost_sources',
              pricing_id: pricingId,
              source_type: 'non_llm_manual',
              tracking_status: 'tracked',
              source_status: 'healthy',
              cost_source_slug: 'tavily-search',
              metric: 'credit',
              unit: 'credit',
              approved_at: '2020-01-01T00:00:00.000Z',
              pricing_model: 'flat',
              unit_cost_usd: toolUnitCostUsd,
            };
    const pricingHash = await jsonHash(transaction, pricingSnapshot);
    const reserveResponse = {
      schema_version: '1.0',
      decision: 'reserved',
      allowed: true,
      decision_id: decisionId,
      operation_id: operationId,
      reservation_id: reservationId,
      state: 'reserved',
      reserved_usd: requestedUsd,
      remaining_usd: period.remaining_usd,
      expires_at: '2000-01-01T00:05:00.000Z',
      warnings: [],
    };
    await transaction`
      INSERT INTO public.budget_reservations (
        builder_id, decision_id, reservation_id, operation_id, schema_version,
        request_hash, request_snapshot, mode, kind, customer_id, trace_id, span_id,
        parent_span_id, step_name, framework, reservation_ttl_seconds,
        provider, model, estimated_input_tokens, max_output_tokens,
        cost_source_slug, tool_name, metric, maximum_value,
        decision, decision_reason, would_have_denied, state,
        pricing_snapshot, pricing_snapshot_hash, requested_usd, reserved_usd,
        actual_usd, released_usd, overage_usd, remaining_usd,
        deciding_account_id, reserve_response_snapshot
      )
      VALUES (
        ${builderId}::UUID, ${decisionId}::UUID, ${reservationId}::UUID,
        ${operationId}::UUID, '1.0', ${requestHash},
        ${transaction.json(requestSnapshot)}::JSONB, 'enforce', ${kind}, 'customer_1',
        ${traceId}::UUID, ${spanId}::UUID, NULL, 'agent.call', 'none', 300,
        ${kind === 'llm' ? 'openai' : null},
        ${kind === 'llm' ? 'gpt-4o-mini' : null},
        ${kind === 'llm' ? 100 : null}, ${kind === 'llm' ? 50 : null},
        ${kind === 'tool' ? 'tavily-search' : null},
        ${kind === 'tool' ? 'tavily_search' : null},
        ${kind === 'tool' ? 'credit' : null},
        ${kind === 'tool' ? toolMaximumValue : null}::NUMERIC,
        'reserved', NULL, NULL, 'reserved',
        ${transaction.json(pricingSnapshot)}::JSONB, ${pricingHash},
        ${requestedUsd}::NUMERIC, ${requestedUsd}::NUMERIC, 0, 0, 0,
        ${period.remaining_usd}::NUMERIC, NULL,
        ${transaction.json(reserveResponse)}::JSONB
      )
    `;

    await transaction`
      INSERT INTO public.budget_reservation_allocations (
        builder_id, id, reservation_decision_id, account_id, rule_key, rule_revision_id,
        rule_snapshot, rule_snapshot_hash, enforcement, evaluation_order,
        is_deciding, account_version_before, held_at_reserve, status,
        committed_before_usd, reserved_before_usd, unresolved_before_usd,
        requested_usd, projected_usd, limit_usd, remaining_usd,
        authorized_usd, actual_usd, released_usd, unresolved_usd, overage_usd
      )
      VALUES (
        ${builderId}::UUID, ${crypto.randomUUID()}::UUID, ${decisionId}::UUID,
        ${accountId}::UUID, ${ruleKey}::UUID, ${ruleRevisionId}::UUID,
        ${transaction.json(accountSnapshot)}::JSONB, ${accountHash},
        'hard_stop', 0, FALSE, 0, TRUE, 'reserved',
        0, 0, 0, ${requestedUsd}::NUMERIC, ${requestedUsd}::NUMERIC,
        ${limitUsd}::NUMERIC, ${period.remaining_usd}::NUMERIC,
        ${requestedUsd}::NUMERIC, 0, 0, 0, 0
      )
    `;
    return { accountId, builderId, decisionId, operationId, reservationId, requestedUsd };
  }) as Promise<HeldFixture>;
}

async function backdateForExpiry(fixture: HeldFixture): Promise<void> {
  await db().begin(async (transaction) => {
    await useBuilder(transaction, fixture.builderId);
    // Owner-only fixture setup in the disposable scratch database.
    await transaction`ALTER TABLE public.budget_reservations DISABLE TRIGGER USER`;
    await transaction`
      UPDATE public.budget_reservations
      SET created_at = ${PAST_RESERVED_AT}::TIMESTAMPTZ,
          updated_at = ${PAST_RESERVED_AT}::TIMESTAMPTZ,
          reserved_at = ${PAST_RESERVED_AT}::TIMESTAMPTZ,
          expires_at = ${PAST_EXPIRES_AT}::TIMESTAMPTZ,
          reserve_response_snapshot = jsonb_set(
            reserve_response_snapshot,
            '{expires_at}',
            to_jsonb(${PAST_EXPIRES_AT}::TEXT)
          )
      WHERE builder_id = ${fixture.builderId}::UUID
        AND decision_id = ${fixture.decisionId}::UUID
    `;
    await transaction`ALTER TABLE public.budget_reservations ENABLE TRIGGER USER`;
  });
}

async function moveLeaseNearBoundary(fixture: HeldFixture): Promise<void> {
  await db().begin(async (transaction) => {
    await useBuilder(transaction, fixture.builderId);
    // Owner-only fixture setup in the disposable scratch database. The
    // production trigger remains enabled before the service call begins.
    await transaction`ALTER TABLE public.budget_reservations DISABLE TRIGGER USER`;
    await transaction`
      WITH boundary AS (
        SELECT date_trunc(
          'milliseconds',
          pg_catalog.clock_timestamp()
            + ${BOUNDARY_LEASE_MILLISECONDS} * INTERVAL '1 millisecond'
        ) AS expires_at
      )
      UPDATE public.budget_reservations reservation
      SET created_at = boundary.expires_at
            - reservation.reservation_ttl_seconds * INTERVAL '1 second',
          updated_at = boundary.expires_at
            - reservation.reservation_ttl_seconds * INTERVAL '1 second',
          reserved_at = boundary.expires_at
            - reservation.reservation_ttl_seconds * INTERVAL '1 second',
          expires_at = boundary.expires_at,
          reserve_response_snapshot = jsonb_set(
            reservation.reserve_response_snapshot,
            '{expires_at}',
            to_jsonb(public.pylva_budget_timestamp_text(boundary.expires_at))
          )
      FROM boundary
      WHERE reservation.builder_id = ${fixture.builderId}::UUID
        AND reservation.decision_id = ${fixture.decisionId}::UUID
    `;
    await transaction`ALTER TABLE public.budget_reservations ENABLE TRIGGER USER`;
  });
}

async function installLeaseBoundaryDelay(): Promise<void> {
  await db()`
    CREATE OR REPLACE FUNCTION public.pylva_lifecycle_test_boundary_delay()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF OLD.state = 'reserved' AND NEW.state <> 'unresolved' THEN
        PERFORM pg_catalog.pg_sleep(1.25);
      END IF;
      RETURN NEW;
    END;
    $function$
  `;
  await db()`DROP TRIGGER IF EXISTS aaa_lifecycle_test_boundary_delay ON public.budget_reservations`;
  await db()`
    CREATE TRIGGER aaa_lifecycle_test_boundary_delay
    BEFORE UPDATE ON public.budget_reservations
    FOR EACH ROW
    EXECUTE FUNCTION public.pylva_lifecycle_test_boundary_delay()
  `;
}

async function removeLeaseBoundaryDelay(): Promise<void> {
  await db()`DROP TRIGGER IF EXISTS aaa_lifecycle_test_boundary_delay ON public.budget_reservations`;
  await db()`DROP FUNCTION IF EXISTS public.pylva_lifecycle_test_boundary_delay()`;
}

async function installOutboxCommitPause(): Promise<void> {
  await db()`
    CREATE OR REPLACE FUNCTION public.pylva_lifecycle_test_outbox_commit_pause()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      PERFORM pg_catalog.pg_advisory_xact_lock(745221::BIGINT);
      RETURN NEW;
    END;
    $function$
  `;
  await db()`
    DROP TRIGGER IF EXISTS zzz_lifecycle_test_outbox_commit_pause
      ON public.budget_cost_event_outbox
  `;
  await db()`
    CREATE TRIGGER zzz_lifecycle_test_outbox_commit_pause
    AFTER INSERT ON public.budget_cost_event_outbox
    FOR EACH ROW
    EXECUTE FUNCTION public.pylva_lifecycle_test_outbox_commit_pause()
  `;
}

async function removeOutboxCommitPause(): Promise<void> {
  await db()`
    DROP TRIGGER IF EXISTS zzz_lifecycle_test_outbox_commit_pause
      ON public.budget_cost_event_outbox
  `;
  await db()`DROP FUNCTION IF EXISTS public.pylva_lifecycle_test_outbox_commit_pause()`;
}

async function waitForBuilderAdvisoryWait(builderId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await raceClient!<{ waiting: boolean }[]>`
      WITH builder_lock AS (
        SELECT pg_catalog.hashtextextended(
          ${builderId}::UUID::TEXT,
          50620260714::BIGINT
        ) AS key
      )
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_locks AS lock
        CROSS JOIN builder_lock
        WHERE lock.locktype = 'advisory'
          AND lock.database = (
            SELECT database.oid
            FROM pg_catalog.pg_database AS database
            WHERE database.datname = pg_catalog.current_database()
          )
          AND lock.classid::BIGINT = ((builder_lock.key >> 32) & 4294967295)
          AND lock.objid::BIGINT = (builder_lock.key & 4294967295)
          AND lock.objsubid = 1
          AND NOT lock.granted
      ) AS waiting
    `;
    if (rows[0]?.waiting) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for builder advisory lock ${builderId}`);
}

async function atLeaseBoundary<T>(fixture: HeldFixture, callback: () => Promise<T>): Promise<T> {
  // Keep the setup UPDATE outside the artificial delay. Otherwise the fixture
  // is already expired before the service transaction begins and this does
  // not exercise a lease crossing inside the guarded lifecycle UPDATE.
  await moveLeaseNearBoundary(fixture);
  await installLeaseBoundaryDelay();
  try {
    return await callback();
  } finally {
    await removeLeaseBoundaryDelay();
  }
}

async function lifecycleRows<T>(
  fixture: HeldFixture,
  callback: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return db().begin(async (transaction) => {
    await useBuilder(transaction, fixture.builderId);
    return callback(transaction);
  }) as Promise<T>;
}

function toolCommit(actualValue: string) {
  return {
    schema_version: '1.0' as const,
    status: 'success' as const,
    latency_ms: 250,
    stream_aborted: false,
    kind: 'tool' as const,
    actual_value: actualValue,
  };
}

function llmCommit(actualInputTokens: number, actualOutputTokens: number) {
  return {
    schema_version: '1.0' as const,
    status: 'success' as const,
    latency_ms: 250,
    stream_aborted: false,
    kind: 'llm' as const,
    actual_input_tokens: actualInputTokens,
    actual_output_tokens: actualOutputTokens,
  };
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'budget_lifecycle_service' });
  try {
    // Applies 051 automatically when the readiness migration is present, while
    // preserving an explicit pre-051 compatibility assertion otherwise.
    await applyMigrationsThrough(scratch, '051');
    service = createBudgetLifecycleService({
      transactionOptions: { client: scratch.sql, maxAttempts: 1 },
    });
    projectionStore = createBudgetProjectionPostgresStore(scratch.sql);
    raceClient = postgres(scratch.url, { max: 4, onnotice: () => undefined });
    raceService = createBudgetLifecycleService({
      transactionOptions: { client: raceClient, maxAttempts: 1 },
    });
    raceProjectionStore = createBudgetProjectionPostgresStore(raceClient);
  } catch (error) {
    await raceClient?.end().catch(() => undefined);
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
});

afterAll(async () => {
  await raceClient?.end().catch(() => undefined);
  await scratch?.drop();
});

describe('authoritative budget lifecycle service', () => {
  it.each([
    { label: 'below', requested: '1', actual: '0.6', released: '0.4', overage: '0' },
    { label: 'equal', requested: '1', actual: '1', released: '0', overage: '0' },
    { label: 'above', requested: '1', actual: '1.25', released: '0', overage: '0.25' },
  ])(
    'commits actual cost $label the hold and creates usage plus outbox exactly once',
    async ({ label, requested, actual, released, overage }) => {
      const builderId = await insertBuilder(`settle-${label}`);
      const fixture = await seedHeldReservation(builderId, {
        limitUsd: requested,
        requestedUsd: requested,
      });
      const first = await service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit(actual),
        SDK_IDENTITY,
      );
      expect(first).toMatchObject({
        state: 'committed',
        reserved_usd: requested,
        actual_usd: actual,
        released_usd: released,
        overage_usd: overage,
        budget_exceeded_after_commit: label === 'above',
        idempotent_replay: false,
        late: false,
      });

      const replay = await service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit(actual),
        SDK_IDENTITY,
      );
      expect(replay).toEqual({ ...first, idempotent_replay: true });
      const counts = await lifecycleRows(fixture, async (transaction) => {
        const rows = await transaction<
          { outbox_count: number; transition_count: number; usage_count: number }[]
        >`
          SELECT
            (SELECT COUNT(*)::INTEGER FROM public.budget_usage_ledger
             WHERE builder_id = ${builderId}::UUID
               AND reservation_decision_id = ${fixture.decisionId}::UUID) AS usage_count,
            (SELECT COUNT(*)::INTEGER FROM public.budget_cost_event_outbox
             WHERE builder_id = ${builderId}::UUID) AS outbox_count,
            (SELECT COUNT(*)::INTEGER FROM public.budget_reservation_transitions
             WHERE builder_id = ${builderId}::UUID
               AND reservation_decision_id = ${fixture.decisionId}::UUID
               AND type = 'commit') AS transition_count
        `;
        return rows[0]!;
      });
      expect(counts).toEqual({ outbox_count: 1, transition_count: 1, usage_count: 1 });
    },
  );

  it('returns 409 for the same terminal identity with a different body and for a conflicting terminal', async () => {
    const builderId = await insertBuilder('terminal-conflict');
    const fixture = await seedHeldReservation(builderId);
    await service.commitBudgetUsage(
      builderId,
      fixture.reservationId,
      toolCommit('0.5'),
      SDK_IDENTITY,
    );
    await expect(
      service.commitBudgetUsage(builderId, fixture.reservationId, toolCommit('0.6'), SDK_IDENTITY),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.releaseBudgetUsage(
        builderId,
        fixture.reservationId,
        { schema_version: '1.0', reason: 'provider_not_called' },
        SDK_IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESERVATION_STATE_CONFLICT' });
  });

  it('releases only with a public proof reason and replays the exact stored result', async () => {
    const builderId = await insertBuilder('release-proof');
    const fixture = await seedHeldReservation(builderId, { requestedUsd: '2.5' });
    const request = {
      schema_version: '1.0' as const,
      reason: 'provider_confirmed_uncharged' as const,
    };
    const first = await service.releaseBudgetUsage(
      builderId,
      fixture.reservationId,
      request,
      SDK_IDENTITY,
    );
    expect(first).toMatchObject({
      state: 'released',
      released_usd: '2.5',
      idempotent_replay: false,
    });
    await expect(
      service.releaseBudgetUsage(
        builderId,
        fixture.reservationId,
        { schema_version: '1.0', reason: 'provider_not_called' },
        SDK_IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await service.releaseBudgetUsage(builderId, fixture.reservationId, request, SDK_IDENTITY),
    ).toEqual({ ...first, idempotent_replay: true });
  });

  it('commits actual tool usage through the frozen graduated-volume snapshot', async () => {
    const builderId = await insertBuilder('volume-tool-settlement');
    const fixture = await seedHeldReservation(builderId, {
      requestedUsd: '0.3',
      toolMaximumValue: '2',
      toolPricingTiers: [
        { from: '0', to: '1', price_per_unit_usd: '0.1' },
        { from: '1', to: null, price_per_unit_usd: '0.2' },
      ],
    });
    await expect(
      service.commitBudgetUsage(builderId, fixture.reservationId, toolCommit('1.5'), SDK_IDENTITY),
    ).resolves.toMatchObject({
      state: 'committed',
      reserved_usd: '0.3',
      actual_usd: '0.2',
      released_usd: '0.1',
      overage_usd: '0',
    });
  });

  it('ceil-rounds one frozen graduated-tier sum once during commit', async () => {
    const builderId = await insertBuilder('volume-tool-one-ceil');
    const fixture = await seedHeldReservation(builderId, {
      requestedUsd: '0.000000000000000001',
      toolMaximumValue: '0.0000000000008',
      toolPricingTiers: [
        { from: '0', to: '0.0000000000004', price_per_unit_usd: '0.000001' },
        { from: '0.0000000000004', to: null, price_per_unit_usd: '0.000001' },
      ],
    });
    await expect(
      service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit('0.0000000000008'),
        SDK_IDENTITY,
      ),
    ).resolves.toMatchObject({
      state: 'committed',
      reserved_usd: '0.000000000000000001',
      actual_usd: '0.000000000000000001',
      released_usd: '0',
      overage_usd: '0',
    });
  });

  it('settles from the immutable snapshot when live pricing changes after reserve', async () => {
    const builderId = await insertBuilder('frozen-price-change');
    const fixture = await seedHeldReservation(builderId, {
      requestedUsd: '1',
      toolMaximumValue: '1',
      toolUnitCostUsd: '1',
    });
    await lifecycleRows(
      fixture,
      (transaction) => transaction`
      INSERT INTO public.cost_sources (
        builder_id, source_type, display_name, slug, metric, unit,
        price_per_unit, pricing_tiers, status, approved_at, tracking_status
      ) VALUES (
        ${builderId}::UUID, 'non_llm_manual', 'Changed live price',
        'tavily-search', 'credit', 'credit', 999, NULL,
        'healthy', pg_catalog.clock_timestamp(), 'tracked'
      )
    `,
    );

    await expect(
      service.commitBudgetUsage(builderId, fixture.reservationId, toolCommit('0.5'), SDK_IDENTITY),
    ).resolves.toMatchObject({
      actual_usd: '0.5',
      released_usd: '0.5',
      overage_usd: '0',
    });
  });

  it('commits exact LLM token cost through the production frozen snapshot shape', async () => {
    const builderId = await insertBuilder('llm-settlement');
    const fixture = await seedHeldReservation(builderId, {
      kind: 'llm',
      requestedUsd: '1',
    });
    await expect(
      service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        llmCommit(1_000_000, 1_000_000),
        SDK_IDENTITY,
      ),
    ).resolves.toMatchObject({
      state: 'committed',
      reserved_usd: '1',
      actual_usd: '0.75',
      released_usd: '0.25',
      overage_usd: '0',
    });
  });

  it('settles a zero-dollar hold without a phantom account-version mutation', async () => {
    const builderId = await insertBuilder('zero-settlement');
    const fixture = await seedHeldReservation(builderId, {
      limitUsd: '1',
      requestedUsd: '0',
      toolMaximumValue: '0',
      toolUnitCostUsd: '1',
    });
    await expect(
      service.commitBudgetUsage(builderId, fixture.reservationId, toolCommit('0'), SDK_IDENTITY),
    ).resolves.toMatchObject({
      state: 'committed',
      reserved_usd: '0',
      actual_usd: '0',
      released_usd: '0',
      overage_usd: '0',
    });
    const rows = await lifecycleRows(
      fixture,
      (transaction) => transaction<
        {
          committed_usd: string;
          reserved_usd: string;
          unresolved_usd: string;
          version: string;
        }[]
      >`
        SELECT account.version::TEXT,
               account.committed_usd::TEXT,
               account.reserved_usd::TEXT,
               account.unresolved_usd::TEXT
        FROM public.budget_accounts account
        WHERE account.builder_id = ${builderId}::UUID
          AND account.id = ${fixture.accountId}::UUID
      `,
    );
    expect(rows[0]).toEqual({
      // committed_usd is intentionally unbounded NUMERIC, so PostgreSQL does
      // not retain a fixed textual scale for zero.
      committed_usd: '0',
      reserved_usd: '0.000000000000000000',
      unresolved_usd: '0.000000000000000000',
      version: '1',
    });
  });

  it('extends a live lease idempotently and never revives an expired reservation', async () => {
    const builderId = await insertBuilder('extend-live');
    const fixture = await seedHeldReservation(builderId);
    const request = {
      schema_version: '1.0' as const,
      extension_id: crypto.randomUUID(),
      extend_by_seconds: 30,
    };
    const first = await service.extendBudgetUsage(
      builderId,
      fixture.reservationId,
      request,
      SDK_IDENTITY,
    );
    expect(first).toMatchObject({ state: 'reserved', idempotent_replay: false });
    expect(
      await service.extendBudgetUsage(builderId, fixture.reservationId, request, SDK_IDENTITY),
    ).toEqual({ ...first, idempotent_replay: true });
    await expect(
      service.extendBudgetUsage(
        builderId,
        fixture.reservationId,
        { ...request, extend_by_seconds: 31 },
        SDK_IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });

    const second = await service.extendBudgetUsage(
      builderId,
      fixture.reservationId,
      { ...request, extension_id: crypto.randomUUID() },
      SDK_IDENTITY,
    );
    expect(Date.parse(second.expires_at) - Date.parse(first.expires_at)).toBe(30_000);
    const extensionRows = await lifecycleRows(
      fixture,
      (transaction) => transaction<{ state_version: string; transitions: number }[]>`
        SELECT reservation.state_version::TEXT,
               COUNT(transition.id)::INTEGER AS transitions
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_transitions transition
          ON transition.builder_id = reservation.builder_id
         AND transition.reservation_decision_id = reservation.decision_id
         AND transition.type = 'extend'
        WHERE reservation.builder_id = ${builderId}::UUID
          AND reservation.decision_id = ${fixture.decisionId}::UUID
        GROUP BY reservation.state_version
      `,
    );
    expect(extensionRows[0]).toEqual({ state_version: '2', transitions: 2 });

    const expiredBuilderId = await insertBuilder('extend-expired');
    const expired = await seedHeldReservation(expiredBuilderId);
    await backdateForExpiry(expired);
    await expect(
      service.extendBudgetUsage(
        expiredBuilderId,
        expired.reservationId,
        { ...request, extension_id: crypto.randomUUID() },
        SDK_IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESERVATION_STATE_CONFLICT' });
  });

  it('does not revive a lease that crosses expiry inside the extension update', async () => {
    const builderId = await insertBuilder('extend-boundary');
    const fixture = await seedHeldReservation(builderId);
    const startedAt = Date.now();
    await expect(
      atLeaseBoundary(fixture, () =>
        service.extendBudgetUsage(
          builderId,
          fixture.reservationId,
          {
            schema_version: '1.0',
            extension_id: crypto.randomUUID(),
            extend_by_seconds: 30,
          },
          SDK_IDENTITY,
        ),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'RESERVATION_STATE_CONFLICT' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BOUNDARY_LEASE_MILLISECONDS);

    const rows = await lifecycleRows(
      fixture,
      (transaction) => transaction<{ state: string; state_version: string; transitions: number }[]>`
        SELECT reservation.state,
               reservation.state_version::TEXT,
               COUNT(transition.id)::INTEGER AS transitions
        FROM public.budget_reservations reservation
        LEFT JOIN public.budget_reservation_transitions transition
          ON transition.builder_id = reservation.builder_id
         AND transition.reservation_decision_id = reservation.decision_id
        WHERE reservation.builder_id = ${builderId}::UUID
          AND reservation.decision_id = ${fixture.decisionId}::UUID
        GROUP BY reservation.state, reservation.state_version
      `,
    );
    expect(rows[0]).toEqual({ state: 'reserved', state_version: '0', transitions: 0 });
  });

  it.each([{ terminal: 'commit' as const }, { terminal: 'release' as const }])(
    'records expiry before $terminal when its terminal update crosses the lease boundary',
    async ({ terminal }) => {
      const builderId = await insertBuilder(`${terminal}-boundary`);
      const fixture = await seedHeldReservation(builderId);
      const startedAt = Date.now();
      const result = await atLeaseBoundary(fixture, async () => {
        if (terminal === 'commit') {
          return service.commitBudgetUsage(
            builderId,
            fixture.reservationId,
            toolCommit('0.75'),
            SDK_IDENTITY,
          );
        }
        return service.releaseBudgetUsage(
          builderId,
          fixture.reservationId,
          { schema_version: '1.0', reason: 'provider_confirmed_uncharged' },
          SDK_IDENTITY,
        );
      });
      expect(result.state).toBe(terminal === 'commit' ? 'committed' : 'released');
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(BOUNDARY_LEASE_MILLISECONDS);

      const rows = await lifecycleRows(
        fixture,
        (transaction) => transaction<{ state: string; transition_types: string[] }[]>`
        SELECT reservation.state,
               ARRAY_AGG(transition.type ORDER BY transition.from_state_version) AS transition_types
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_transitions transition
          ON transition.builder_id = reservation.builder_id
         AND transition.reservation_decision_id = reservation.decision_id
        WHERE reservation.builder_id = ${builderId}::UUID
          AND reservation.decision_id = ${fixture.decisionId}::UUID
        GROUP BY reservation.state
      `,
      );
      expect(rows[0]).toEqual({
        state: terminal === 'commit' ? 'committed' : 'released',
        transition_types: ['expire_unresolved', terminal],
      });
      if (terminal === 'commit') {
        expect(result).toMatchObject({ late: true, actual_usd: '0.75' });
      }
    },
  );

  it('expires first and then late-commits in the same transaction', async () => {
    const builderId = await insertBuilder('late-commit');
    const fixture = await seedHeldReservation(builderId);
    await backdateForExpiry(fixture);
    const response = await service.commitBudgetUsage(
      builderId,
      fixture.reservationId,
      toolCommit('0.75'),
      SDK_IDENTITY,
    );
    expect(response).toMatchObject({ state: 'committed', late: true, actual_usd: '0.75' });
    const rows = await lifecycleRows(
      fixture,
      async (transaction) =>
        transaction<
          {
            committed_usd: string;
            reserved_usd: string;
            state: string;
            state_version: string;
            transition_types: string[];
            unresolved_usd: string;
          }[]
        >`
        SELECT reservation.state, reservation.state_version::TEXT,
               account.committed_usd::TEXT, account.reserved_usd::TEXT,
               account.unresolved_usd::TEXT,
               ARRAY_AGG(transition.type ORDER BY transition.from_state_version) AS transition_types
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        JOIN public.budget_reservation_transitions transition
          ON transition.builder_id = reservation.builder_id
         AND transition.reservation_decision_id = reservation.decision_id
        WHERE reservation.builder_id = ${builderId}::UUID
          AND reservation.decision_id = ${fixture.decisionId}::UUID
        GROUP BY reservation.state, reservation.state_version,
                 account.committed_usd, account.reserved_usd, account.unresolved_usd
      `,
    );
    expect(rows[0]).toEqual({
      committed_usd: '0.750000000000000000',
      reserved_usd: '0.000000000000000000',
      state: 'committed',
      state_version: '2',
      transition_types: ['expire_unresolved', 'commit'],
      unresolved_usd: '0.000000000000000000',
    });
  });

  it('claims due expiry work with SKIP LOCKED and posts unresolved capacity once', async () => {
    const builderId = await insertBuilder('expiry-worker');
    const fixture = await seedHeldReservation(builderId, { requestedUsd: '3' });
    await backdateForExpiry(fixture);
    const results = await Promise.all([
      raceService.expireDueBudgetReservations(builderId, 1),
      raceService.expireDueBudgetReservations(builderId, 1),
    ]);
    expect(results[0]!.expired + results[1]!.expired).toBe(1);
    expect(await service.expireDueBudgetReservations(builderId, 1)).toEqual({ expired: 0 });
    const rows = await lifecycleRows(
      fixture,
      (transaction) =>
        transaction<
          {
            reserved_usd: string;
            state: string;
            transition_count: number;
            unresolved_usd: string;
          }[]
        >`
        SELECT reservation.state, account.reserved_usd::TEXT,
               account.unresolved_usd::TEXT,
               COUNT(transition.id)::INTEGER AS transition_count
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        JOIN public.budget_reservation_transitions transition
          ON transition.builder_id = reservation.builder_id
         AND transition.reservation_decision_id = reservation.decision_id
        WHERE reservation.builder_id = ${builderId}::UUID
          AND reservation.decision_id = ${fixture.decisionId}::UUID
        GROUP BY reservation.state, account.reserved_usd, account.unresolved_usd
      `,
    );
    expect(rows[0]).toEqual({
      reserved_usd: '0.000000000000000000',
      state: 'unresolved',
      transition_count: 1,
      unresolved_usd: '3.000000000000000000',
    });
  });

  it('serializes a commit/release race to exactly one terminal transition', async () => {
    const builderId = await insertBuilder('terminal-race');
    const fixture = await seedHeldReservation(builderId);
    const outcomes = await Promise.allSettled([
      raceService.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit('0.8'),
        SDK_IDENTITY,
      ),
      raceService.releaseBudgetUsage(
        builderId,
        fixture.reservationId,
        { schema_version: '1.0', reason: 'provider_not_called' },
        SDK_IDENTITY,
      ),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ status: 409, code: 'RESERVATION_STATE_CONFLICT' }),
    });
    const rows = await lifecycleRows(
      fixture,
      (transaction) =>
        transaction<{ terminal_count: number; usage_count: number }[]>`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM public.budget_reservation_transitions
           WHERE builder_id = ${builderId}::UUID
             AND reservation_decision_id = ${fixture.decisionId}::UUID
             AND type IN ('commit', 'release')) AS terminal_count,
          (SELECT COUNT(*)::INTEGER FROM public.budget_usage_ledger
           WHERE builder_id = ${builderId}::UUID
             AND reservation_decision_id = ${fixture.decisionId}::UUID) AS usage_count
      `,
    );
    expect(rows[0]?.terminal_count).toBe(1);
    expect([0, 1]).toContain(rows[0]?.usage_count);
  });

  it('coalesces concurrent identical commits into one usage and one outbox event', async () => {
    const builderId = await insertBuilder('duplicate-commit-race');
    const fixture = await seedHeldReservation(builderId);
    const outcomes = await Promise.all([
      raceService.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit('0.8'),
        SDK_IDENTITY,
      ),
      raceService.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit('0.8'),
        SDK_IDENTITY,
      ),
    ]);
    expect(outcomes.map((result) => result.idempotent_replay).sort()).toEqual([false, true]);
    expect(outcomes[0]).toMatchObject({ actual_usd: '0.8', state: 'committed' });
    expect(outcomes[1]).toMatchObject({ actual_usd: '0.8', state: 'committed' });

    const counts = await lifecycleRows(
      fixture,
      (transaction) => transaction<
        { outbox_count: number; transition_count: number; usage_count: number }[]
      >`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM public.budget_usage_ledger
           WHERE builder_id = ${builderId}::UUID
             AND reservation_decision_id = ${fixture.decisionId}::UUID) AS usage_count,
          (SELECT COUNT(*)::INTEGER FROM public.budget_cost_event_outbox
           WHERE builder_id = ${builderId}::UUID) AS outbox_count,
          (SELECT COUNT(*)::INTEGER FROM public.budget_reservation_transitions
           WHERE builder_id = ${builderId}::UUID
             AND reservation_decision_id = ${fixture.decisionId}::UUID
             AND type = 'commit') AS transition_count
      `,
    );
    expect(counts[0]).toEqual({ outbox_count: 1, transition_count: 1, usage_count: 1 });
  });

  it('rolls back parent, allocations, usage, and transition when outbox insertion fails', async () => {
    const builderId = await insertBuilder('atomic-rollback');
    const fixture = await seedHeldReservation(builderId);
    await db()`
      ALTER TABLE public.budget_cost_event_outbox
      ADD CONSTRAINT lifecycle_test_forced_failure_ck CHECK (FALSE) NOT VALID
    `;
    try {
      await expect(
        service.commitBudgetUsage(
          builderId,
          fixture.reservationId,
          toolCommit('0.5'),
          SDK_IDENTITY,
        ),
      ).rejects.toThrow(/lifecycle_test_forced_failure_ck/i);
    } finally {
      await db()`
        ALTER TABLE public.budget_cost_event_outbox
        DROP CONSTRAINT IF EXISTS lifecycle_test_forced_failure_ck
      `;
    }
    const rows = await lifecycleRows(
      fixture,
      (transaction) =>
        transaction<
          {
            reserved_usd: string;
            state: string;
            transition_count: number;
            usage_count: number;
          }[]
        >`
        SELECT reservation.state, account.reserved_usd::TEXT,
               (SELECT COUNT(*)::INTEGER FROM public.budget_usage_ledger
                WHERE builder_id = ${builderId}::UUID
                  AND reservation_decision_id = ${fixture.decisionId}::UUID) AS usage_count,
               (SELECT COUNT(*)::INTEGER FROM public.budget_reservation_transitions
                WHERE builder_id = ${builderId}::UUID
                  AND reservation_decision_id = ${fixture.decisionId}::UUID) AS transition_count
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        WHERE reservation.builder_id = ${builderId}::UUID
          AND reservation.decision_id = ${fixture.decisionId}::UUID
      `,
    );
    expect(rows[0]).toEqual({
      reserved_usd: '1.000000000000000000',
      state: 'reserved',
      transition_count: 0,
      usage_count: 0,
    });
  });

  it('returns a tenant-safe 404 for a reservation owned by another builder', async () => {
    const ownerBuilder = await insertBuilder('tenant-owner');
    const foreignBuilder = await insertBuilder('tenant-foreign');
    const fixture = await seedHeldReservation(ownerBuilder);
    await expect(
      service.commitBudgetUsage(
        foreignBuilder,
        fixture.reservationId,
        toolCommit('0.5'),
        SDK_IDENTITY,
      ),
    ).rejects.toBeInstanceOf(BudgetLifecycleError);
    await expect(
      service.commitBudgetUsage(
        foreignBuilder,
        fixture.reservationId,
        toolCommit('0.5'),
        SDK_IDENTITY,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'RESOURCE_NOT_FOUND' });
  });

  it('commits the v1 tool maximum only when widened runtime columns are present', async () => {
    const precisionRows = await db()<{ numeric_precision: number }[]>`
      SELECT numeric_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'budget_usage_ledger'
        AND column_name = 'actual_cost_usd'
    `;
    const wideRuntime = precisionRows[0]?.numeric_precision === 44;
    const builderId = await insertBuilder('wide-actual');
    const fixture = await seedHeldReservation(builderId, {
      limitUsd: '99999999999999999999',
      requestedUsd: '999999.999999',
      toolMaximumValue: '1',
      toolUnitCostUsd: '999999.999999',
    });
    const request = toolCommit('99999999999999999999.999999999999999999');
    if (wideRuntime) {
      const response = await service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        request,
        SDK_IDENTITY,
      );
      expect(response.actual_usd).toBe('99999999999899999999999999.999999999999000001');
      expect(response.overage_usd).toBe('99999999999899999999000000.000000999999000001');
      const evidence = await lifecycleRows(
        fixture,
        (transaction) => transaction<
          {
            actual_cost_usd: string;
            actual_value: string;
            declared_maximum: string;
            outbox_cost_usd: string;
            outbox_metric_value: string;
          }[]
        >`
          SELECT public.pylva_budget_decimal_text(reservation.maximum_value) AS declared_maximum,
                 public.pylva_budget_decimal_text(usage.actual_value) AS actual_value,
                 public.pylva_budget_decimal_text(usage.actual_cost_usd) AS actual_cost_usd,
                 outbox.payload->>'metric_value' AS outbox_metric_value,
                 outbox.payload->>'cost_usd' AS outbox_cost_usd
          FROM public.budget_reservations reservation
          JOIN public.budget_usage_ledger usage
            ON usage.builder_id = reservation.builder_id
           AND usage.reservation_decision_id = reservation.decision_id
          JOIN public.budget_cost_event_outbox outbox
            ON outbox.builder_id = usage.builder_id
           AND outbox.usage_ledger_id = usage.id
          WHERE reservation.builder_id = ${builderId}::UUID
            AND reservation.decision_id = ${fixture.decisionId}::UUID
        `,
      );
      expect(evidence[0]).toEqual({
        actual_cost_usd: '99999999999899999999999999.999999999999000001',
        actual_value: '99999999999999999999.999999999999999999',
        declared_maximum: '1',
        outbox_cost_usd: '99999999999899999999999999.999999999999000001',
        outbox_metric_value: '99999999999999999999.999999999999999999',
      });
    } else {
      await expect(
        service.commitBudgetUsage(builderId, fixture.reservationId, request, SDK_IDENTITY),
      ).rejects.toBeInstanceOf(BudgetLifecycleSchemaBlockerError);
      const rows = await lifecycleRows(
        fixture,
        (transaction) =>
          transaction<{ state: string; usage_count: number }[]>`
          SELECT state,
                 (SELECT COUNT(*)::INTEGER FROM public.budget_usage_ledger
                  WHERE builder_id = ${builderId}::UUID) AS usage_count
          FROM public.budget_reservations
          WHERE builder_id = ${builderId}::UUID
            AND decision_id = ${fixture.decisionId}::UUID
        `,
      );
      expect(rows[0]).toEqual({ state: 'reserved', usage_count: 0 });
    }
  });
});

describe('authoritative projection billing transaction barrier', () => {
  it('waits for an already-open pre-cutoff lifecycle commit and sees its unverified outbox', async () => {
    const builderId = await insertBuilder('billing-barrier-open-commit');
    const fixture = await seedHeldReservation(builderId);
    const blockerReady = deferred();
    const releaseBlocker = deferred();
    let blockerPromise: Promise<unknown> | undefined;
    let commitPromise: Promise<unknown> | undefined;

    await installOutboxCommitPause();
    try {
      blockerPromise = raceClient!.begin(async (transaction) => {
        await transaction`
          SELECT pg_catalog.pg_advisory_xact_lock(${BILLING_BARRIER_TEST_LOCK}::BIGINT)
        `;
        blockerReady.resolve();
        await releaseBlocker.promise;
      }) as Promise<unknown>;
      await blockerReady.promise;

      commitPromise = service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit('0.8'),
        SDK_IDENTITY,
      );
      await waitForAdvisoryWait(BILLING_BARRIER_TEST_LOCK);

      // The lifecycle transaction already stamped committed_at and inserted
      // the outbox row, but neither is visible until the transaction commits.
      const exclusiveEventTime = new Date().toISOString();
      await delay(5);
      const gatePromise = raceProjectionStore.billingGate(builderId, exclusiveEventTime);
      await expectStillPending(gatePromise);

      releaseBlocker.resolve();
      await blockerPromise;
      const [commit, gate] = await Promise.all([commitPromise, gatePromise]);
      expect(commit).toMatchObject({ state: 'committed' });
      expect(Date.parse((commit as { committed_at: string }).committed_at)).toBeLessThanOrEqual(
        Date.parse(exclusiveEventTime),
      );
      expect(gate).toEqual({ closed: true, verified: false });
    } finally {
      releaseBlocker.resolve();
      await blockerPromise?.catch(() => undefined);
      await commitPromise?.catch(() => undefined);
      await removeOutboxCommitPause();
    }
  });

  it('timestamps a lifecycle commit after the cutoff when it waits behind the gate lock', async () => {
    const builderId = await insertBuilder('billing-barrier-later-commit');
    const fixture = await seedHeldReservation(builderId);
    const gateLockReady = deferred();
    const releaseGateLock = deferred();
    let gateLockPromise: Promise<unknown> | undefined;
    let commitPromise: ReturnType<BudgetLifecycleService['commitBudgetUsage']> | undefined;

    try {
      gateLockPromise = raceClient!.begin(async (transaction) => {
        await useBuilder(transaction, builderId);
        await acquireBudgetBuilderExclusiveLock(transaction, builderId);
        gateLockReady.resolve();
        await releaseGateLock.promise;
      }) as Promise<unknown>;
      await gateLockReady.promise;

      const exclusiveEventTime = new Date().toISOString();
      commitPromise = service.commitBudgetUsage(
        builderId,
        fixture.reservationId,
        toolCommit('0.8'),
        SDK_IDENTITY,
      );
      await waitForBuilderAdvisoryWait(builderId);
      await expectStillPending(commitPromise);

      releaseGateLock.resolve();
      await gateLockPromise;
      const commit = await commitPromise;
      expect(Date.parse(commit.committed_at)).toBeGreaterThan(Date.parse(exclusiveEventTime));
      expect(await raceProjectionStore.billingGate(builderId, exclusiveEventTime)).toEqual({
        closed: true,
        verified: true,
      });
    } finally {
      releaseGateLock.resolve();
      await gateLockPromise?.catch(() => undefined);
      await commitPromise?.catch(() => undefined);
    }
  });

  it('treats an in-flight reconciliation as a safe false-negative until its commit is visible', async () => {
    const builderId = await insertBuilder('billing-barrier-reconciliation');
    const fixture = await seedHeldReservation(builderId);
    const commit = await service.commitBudgetUsage(
      builderId,
      fixture.reservationId,
      toolCommit('0.8'),
      SDK_IDENTITY,
    );
    const [lease] = await projectionStore.claim(builderId, createBudgetProjectionWorkerId(), 1);
    expect(lease).toBeDefined();
    expect(await projectionStore.markProjected(lease!)).toBe(true);

    const reconciliationVisible = deferred();
    const releaseReconciliation = deferred();
    let reconciliationPromise: Promise<unknown> | undefined;
    try {
      reconciliationPromise = raceClient!.begin(async (transaction) => {
        await useBuilder(transaction, builderId);
        const rows = await transaction<{ id: string }[]>`
          UPDATE public.budget_cost_event_outbox
          SET projection_verified_at = date_trunc('milliseconds', statement_timestamp())
          WHERE builder_id = ${builderId}::UUID
            AND id = ${lease!.outbox_id}::UUID
            AND status = 'projected'
            AND projection_verified_at IS NULL
          RETURNING id
        `;
        if (rows.length !== 1) throw new Error('reconciliation fixture update failed');
        reconciliationVisible.resolve();
        await releaseReconciliation.promise;
      }) as Promise<unknown>;
      await reconciliationVisible.promise;

      const exclusiveEventTime = new Date().toISOString();
      expect(Date.parse(commit.committed_at)).toBeLessThanOrEqual(Date.parse(exclusiveEventTime));
      // READ COMMITTED sees the last committed version (still unverified), so
      // an in-flight verifier can delay billing but can never open it early.
      expect(await raceProjectionStore.billingGate(builderId, exclusiveEventTime)).toEqual({
        closed: true,
        verified: false,
      });

      releaseReconciliation.resolve();
      await reconciliationPromise;
      expect(await raceProjectionStore.billingGate(builderId, exclusiveEventTime)).toEqual({
        closed: true,
        verified: true,
      });
    } finally {
      releaseReconciliation.resolve();
      await reconciliationPromise?.catch(() => undefined);
    }
  });
});
