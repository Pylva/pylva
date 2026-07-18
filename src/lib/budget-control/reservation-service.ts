import crypto from 'node:crypto';
import type postgres from 'postgres';
import type { Sql, TransactionSql } from 'postgres';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetBypassReason,
  BudgetControlMode,
  BudgetControlWarningCode,
  BudgetReservationState,
  BudgetUnavailableReason,
  CanonicalDecimalSchema,
  ErrorCode,
  ReserveDecision,
  ReserveUsageResponseSchema,
  type BudgetControlWarning,
  type ParsedReserveUsageRequest,
  type ReserveUsageResponse,
} from '@pylva/shared';
import * as v from 'valibot';
import type { BudgetControlSdkIdentity } from './sdk-identity.js';
import {
  acquireBudgetBuilderSharedLock,
  acquireBudgetOperationLock,
  budgetTransactionRetryDelayMs,
  classifyBudgetTransactionError,
  MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS,
  pgCanonicalJsonbSha256,
  pgJsonbParameterText,
  withBudgetControlTransaction,
} from './transaction.js';
import {
  resolveAuthoritativePricing,
  type AuthoritativePricingResult,
  type AuthoritativePricingUnavailableCause,
  type AuthoritativePricingUsage,
} from './pricing.js';

type JsonObject = Record<string, postgres.JSONValue | undefined>;

const ZERO_HASH = '0'.repeat(64);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PUBLIC_BUDGET_EXCLUSIVE = '100000000000000000000';
const PLACEHOLDER_EXPIRES_AT = '0001-01-01T00:00:00.000Z';
const DEFAULT_RESERVATION_ATTEMPTS = 3;
const MAX_PRICING_SNAPSHOT_DEPTH = 32;
const MAX_PRICING_SNAPSHOT_NODES = 4_096;
const PRICING_UNAVAILABLE_CAUSES = new Set<AuthoritativePricingUnavailableCause>([
  'invalid_input',
  'not_found',
  'ambiguous',
  'malformed',
  'out_of_range',
]);

export class BudgetIdempotencyConflictError extends Error {
  readonly code = ErrorCode.IDEMPOTENCY_CONFLICT;
  readonly status = 409;

  constructor() {
    super('operation_id was already used with a different canonical request');
    this.name = 'BudgetIdempotencyConflictError';
  }
}

/** Deterministic materialization/readiness failures carried into the decision. */
export class BudgetAccountMaterializationUnavailableError extends Error {
  readonly retryable: boolean;

  constructor(
    message = 'budget account materialization adapter is not configured',
    retryable = false,
  ) {
    super(message);
    this.name = 'BudgetAccountMaterializationUnavailableError';
    this.retryable = retryable;
  }
}

class MissingBudgetAccountClosureError extends Error {
  readonly code = '23514';

  constructor() {
    // This exact migration-classified closure failure is safe to retry from a
    // fresh account-materialization + authorization pair.
    super('reserved lifecycle requires matching allocation settlement');
    this.name = 'MissingBudgetAccountClosureError';
  }
}

export interface EnsureBudgetAccountsMaterializedInput {
  builderId: string;
  customerId: string;
}

export type EnsureBudgetAccountsMaterialized = (
  input: EnsureBudgetAccountsMaterializedInput,
) => Promise<void>;

export interface ReservationPricingInput {
  tx: TransactionSql;
  builderId: string;
  usage: AuthoritativePricingUsage;
}

export type ResolveReservationPricing = (
  input: ReservationPricingInput,
) => Promise<AuthoritativePricingResult>;

export interface ReserveAuthorizationAttemptInput {
  builderId: string;
  /**
   * Whether a durable generic control-unavailable result should invite a new
   * logical authorization attempt. Same-operation transport retries always
   * replay the stored decision regardless of this value.
   */
  controlFailureRetryable?: boolean;
  request: ParsedReserveUsageRequest;
  requestSnapshot: JsonObject;
  sdkIdentity?: BudgetControlSdkIdentity;
}

export type ReserveAuthorizationAttempt = (
  input: ReserveAuthorizationAttemptInput,
) => Promise<ReserveUsageResponse>;

export interface ReserveBudgetUsageDependencies {
  /** Rollout flag. Disabled control never depends on PostgreSQL availability. */
  controlEnabled?: () => boolean | Promise<boolean>;
  /** Separate, exclusive-lock transaction supplied by the account service. */
  ensureBudgetAccountsMaterialized?: EnsureBudgetAccountsMaterialized;
  /** Same raw postgres.js transaction used by authorization. */
  resolvePricing?: ResolveReservationPricing;
  /** Raw client injection for real-PostgreSQL integration tests. */
  client?: Sql;
  /** High-level seams for deterministic orchestration unit tests. */
  authorizeAttempt?: ReserveAuthorizationAttempt;
  persistControlFailure?: ReserveAuthorizationAttempt;
  randomUUID?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
}

interface ActiveRevisionRow {
  id: string;
}

interface BuilderReadinessRow {
  ready: boolean;
}

interface ExistingDecisionRow {
  request_hash: string;
  reserve_response_snapshot: unknown;
}

interface LockedBudgetAccountRow {
  account_id: string;
  account_version_before: string;
  committed_before_usd: string;
  enforcement: 'hard_stop' | 'advisory';
  exceeds_limit: boolean;
  hard_remaining_usd: string | null;
  limit_usd: string;
  period: 'hour' | 'day' | 'week' | 'month';
  period_end: string;
  period_start: string;
  projected_usd: string;
  public_range_overflow: boolean;
  remaining_usd: string;
  reserved_before_usd: string;
  rule_key: string;
  rule_revision_id: string;
  rule_snapshot: JsonObject;
  rule_snapshot_hash: string;
  scope: 'pooled' | 'per_customer';
  subject_customer_id: string | null;
  unresolved_before_usd: string;
}

interface PricedReservation {
  pricingSnapshot: JsonObject;
  pricingSnapshotHash: string;
  requestedUsd: string;
}

interface ReservationInsert {
  decision: 'reserved' | 'denied' | 'bypassed' | 'unavailable';
  decisionId: string;
  decisionReason: string | null;
  decidingAccountId: string | null;
  pricing: PricedReservation | null;
  remainingUsd: string | null;
  request: ParsedReserveUsageRequest;
  requestHash: string;
  requestSnapshot: JsonObject;
  reservationId: string | null;
  reserveResponse: ReserveUsageResponse;
  reservedUsd: string;
  state: 'reserved' | 'refused' | null;
  wouldHaveDenied: boolean | null;
}

interface AllocationInsert {
  account: LockedBudgetAccountRow;
  authorizedUsd: string;
  evaluationOrder: number;
  heldAtReserve: boolean;
  isDeciding: boolean;
  requestedUsd: string;
  status: 'reserved' | 'refused' | 'not_held' | 'shadow';
}

function asJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Treat the pricing adapter as a runtime trust boundary even though the
 * TypeScript signature is precise. A bad/custom adapter must produce one
 * durable non-retryable control decision, not an accidental retry storm or a
 * database serialization error. The bounds also keep pathological cyclic or
 * deeply nested values away from postgres.js's JSON encoder.
 */
function isBoundedJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;

  const seen = new Set<object>();
  let nodeCount = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodeCount += 1;
    if (nodeCount > MAX_PRICING_SNAPSHOT_NODES || depth > MAX_PRICING_SNAPSHOT_DEPTH) {
      return false;
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return true;
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object') return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);

    const valid = Array.isArray(candidate)
      ? candidate.every((item) => visit(item, depth + 1))
      : (Object.getPrototypeOf(candidate) === Object.prototype ||
          Object.getPrototypeOf(candidate) === null) &&
        Object.values(candidate).every((item) => visit(item, depth + 1));
    seen.delete(candidate);
    return valid;
  };

  return visit(value, 0);
}

function isPricingUnavailableCause(value: unknown): value is AuthoritativePricingUnavailableCause {
  return (
    typeof value === 'string' &&
    PRICING_UNAVAILABLE_CAUSES.has(value as AuthoritativePricingUnavailableCause)
  );
}

function validateMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS) {
    throw new RangeError(
      `maxAttempts must be an integer between 1 and ${MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS}`,
    );
  }
  return value;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof BudgetIdempotencyConflictError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === ErrorCode.IDEMPOTENCY_CONFLICT)
  );
}

function deterministicControlFailureRetryability(error: unknown): boolean | null {
  return error instanceof BudgetAccountMaterializationUnavailableError ? error.retryable : null;
}

function assertStoredResponse(value: unknown): ReserveUsageResponse {
  const parsed = v.safeParse(ReserveUsageResponseSchema, value);
  if (!parsed.success) {
    throw new Error('stored budget reservation response failed its wire contract');
  }
  // Return the JSONB value itself, not Valibot's projection, so an idempotent
  // replay preserves any future additive response fields exactly.
  return value as ReserveUsageResponse;
}

export function canonicalReserveRequestSnapshot(request: ParsedReserveUsageRequest): JsonObject {
  const common: JsonObject = {
    schema_version: request.schema_version,
    mode: request.mode,
    operation_id: request.operation_id,
    customer_id: request.customer_id,
    trace_id: request.trace_id,
    span_id: request.span_id,
    parent_span_id: request.parent_span_id,
    step_name: request.step_name,
    framework: request.framework,
    reservation_ttl_seconds: request.reservation_ttl_seconds,
    kind: request.kind,
  };

  if (request.kind === 'llm') {
    return {
      ...common,
      provider: request.provider,
      model: request.model,
      estimated_input_tokens: request.estimated_input_tokens,
      max_output_tokens: request.max_output_tokens,
    };
  }

  return {
    ...common,
    cost_source_slug: request.cost_source_slug,
    tool_name: request.tool_name,
    metric: request.metric,
    maximum_value: request.maximum_value,
  };
}

function pricingUsage(request: ParsedReserveUsageRequest): AuthoritativePricingUsage {
  return request.kind === 'llm'
    ? {
        kind: 'llm',
        provider: request.provider,
        model: request.model,
        estimated_input_tokens: request.estimated_input_tokens,
        max_output_tokens: request.max_output_tokens,
      }
    : {
        kind: 'tool',
        cost_source_slug: request.cost_source_slug,
        metric: request.metric,
        maximum_value: request.maximum_value,
      };
}

function controlDisabledResponse(request: ParsedReserveUsageRequest): ReserveUsageResponse {
  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: ReserveDecision.BYPASSED,
    allowed: true,
    decision_id: null,
    operation_id: request.operation_id,
    reason: BudgetBypassReason.CONTROL_DISABLED,
    would_have_denied: null,
    warnings: [],
  };
}

function ephemeralControlFailureResponse(request: ParsedReserveUsageRequest): ReserveUsageResponse {
  if (request.mode === BudgetControlMode.SHADOW) {
    return {
      schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
      decision: ReserveDecision.BYPASSED,
      allowed: true,
      decision_id: null,
      operation_id: request.operation_id,
      reason: BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
      would_have_denied: null,
      warnings: [],
    };
  }

  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: ReserveDecision.UNAVAILABLE,
    allowed: false,
    decision_id: null,
    operation_id: request.operation_id,
    reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
    retryable: true,
  };
}

function unavailableReasonForPricingCause(
  cause: AuthoritativePricingUnavailableCause,
): 'pricing_unavailable' | 'usage_bound_required' | 'control_unavailable' {
  if (cause === 'invalid_input') return BudgetUnavailableReason.USAGE_BOUND_REQUIRED;
  if (cause === 'out_of_range' || cause === 'malformed') {
    return BudgetUnavailableReason.CONTROL_UNAVAILABLE;
  }
  return BudgetUnavailableReason.PRICING_UNAVAILABLE;
}

function noApplicableBudgetResponse(
  request: ParsedReserveUsageRequest,
  decisionId: string,
): ReserveUsageResponse {
  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: ReserveDecision.BYPASSED,
    allowed: true,
    decision_id: decisionId,
    operation_id: request.operation_id,
    reason: BudgetBypassReason.NO_APPLICABLE_BUDGET,
    would_have_denied: null,
    warnings: [],
  };
}

function shadowControlUnavailableResponse(
  request: ParsedReserveUsageRequest,
  decisionId: string,
): ReserveUsageResponse {
  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: ReserveDecision.BYPASSED,
    allowed: true,
    decision_id: decisionId,
    operation_id: request.operation_id,
    reason: BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
    would_have_denied: null,
    warnings: [],
  };
}

function unavailableResponse(
  request: ParsedReserveUsageRequest,
  decisionId: string,
  reason: 'pricing_unavailable' | 'usage_bound_required' | 'control_unavailable',
  retryable: boolean,
): ReserveUsageResponse {
  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: ReserveDecision.UNAVAILABLE,
    allowed: false,
    decision_id: decisionId,
    operation_id: request.operation_id,
    reason,
    retryable,
  };
}

async function replayIfPresent(
  tx: TransactionSql,
  builderId: string,
  operationId: string,
  requestHash: string,
): Promise<ReserveUsageResponse | null> {
  const rows = await tx<ExistingDecisionRow[]>`
    SELECT request_hash, reserve_response_snapshot
    FROM public.budget_reservations
    WHERE builder_id = ${builderId}::UUID
      AND operation_id = ${operationId}::UUID
  `;
  const existing = rows[0];
  if (!existing) return null;
  if (existing.request_hash !== requestHash) {
    throw new BudgetIdempotencyConflictError();
  }
  return assertStoredResponse(existing.reserve_response_snapshot);
}

async function activeRevisionIds(
  tx: TransactionSql,
  builderId: string,
  customerId: string,
): Promise<string[]> {
  const rows = await tx<ActiveRevisionRow[]>`
    SELECT id
    FROM public.budget_rule_revisions
    WHERE builder_id = ${builderId}::UUID
      AND retired_at IS NULL
      AND (target_customer_id IS NULL OR target_customer_id = ${customerId})
    ORDER BY id
  `;
  return rows.map((row) => row.id);
}

async function builderControlIsReady(tx: TransactionSql, builderId: string): Promise<boolean> {
  const rows = await tx<BuilderReadinessRow[]>`
    SELECT EXISTS (
      SELECT 1
      FROM public.budget_control_cutovers cutover
      WHERE cutover.builder_id = ${builderId}::UUID
        AND cutover.status = 'ready'
        AND cutover.ready_at IS NOT NULL
        AND cutover.cutover_at <= pg_catalog.clock_timestamp()
    ) AS ready
  `;
  return rows.length === 1 && rows[0]?.ready === true;
}

async function lockedCurrentAccounts(
  tx: TransactionSql,
  builderId: string,
  customerId: string,
  revisionIds: string[],
  requestedUsd: string,
): Promise<LockedBudgetAccountRow[]> {
  const rows = await tx<LockedBudgetAccountRow[]>`
    WITH authoritative_time AS MATERIALIZED (
      SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS value
    ), current_revisions AS MATERIALIZED (
      SELECT revision.id, revision.rule_key, revision.scope, revision.period,
             revision.enforcement, revision.limit_usd,
             CASE revision.period
               WHEN 'hour' THEN date_trunc('hour', clock.value AT TIME ZONE 'UTC')
                                  AT TIME ZONE 'UTC'
               WHEN 'day' THEN date_trunc('day', clock.value AT TIME ZONE 'UTC')
                                 AT TIME ZONE 'UTC'
               WHEN 'week' THEN date_trunc('week', clock.value AT TIME ZONE 'UTC')
                                  AT TIME ZONE 'UTC'
               WHEN 'month' THEN date_trunc('month', clock.value AT TIME ZONE 'UTC')
                                   AT TIME ZONE 'UTC'
             END AS period_start
      FROM public.budget_rule_revisions revision
      CROSS JOIN authoritative_time clock
      WHERE revision.builder_id = ${builderId}::UUID
        AND revision.id = ANY(${revisionIds}::UUID[])
        AND revision.retired_at IS NULL
    ), locked AS MATERIALIZED (
      SELECT account.id AS account_id, account.rule_key, account.scope,
             account.subject_customer_id, account.period, account.period_start,
             account.period_end, account.opening_committed_usd,
             account.committed_usd, account.reserved_usd, account.unresolved_usd,
             account.version, revision.id AS rule_revision_id,
             revision.enforcement, revision.limit_usd
      FROM current_revisions revision
      JOIN public.budget_accounts account
        ON account.builder_id = ${builderId}::UUID
       AND account.rule_key = revision.rule_key
       AND account.scope = revision.scope
       AND account.period = revision.period
       AND account.period_start = revision.period_start
       AND account.subject_customer_id IS NOT DISTINCT FROM
         CASE WHEN revision.scope = 'pooled' THEN NULL ELSE ${customerId} END
      ORDER BY account.id
      FOR UPDATE OF account
    ), arithmetic AS (
      SELECT locked.*,
             locked.committed_usd + locked.reserved_usd + locked.unresolved_usd
               + ${requestedUsd}::NUMERIC AS projected_usd
      FROM locked
    ), evaluated AS (
      SELECT arithmetic.*,
             arithmetic.projected_usd > arithmetic.limit_usd AS exceeds_limit,
             CASE
               WHEN arithmetic.projected_usd <= arithmetic.limit_usd
                 THEN arithmetic.limit_usd - arithmetic.projected_usd
               ELSE GREATEST(
                 arithmetic.limit_usd - arithmetic.committed_usd
                   - arithmetic.reserved_usd - arithmetic.unresolved_usd,
                 0
               )
             END AS remaining_usd
      FROM arithmetic
    )
    SELECT account_id, rule_key, rule_revision_id, scope, subject_customer_id,
           period,
           public.pylva_budget_timestamp_text(period_start) AS period_start,
           public.pylva_budget_timestamp_text(period_end) AS period_end,
           enforcement,
           public.pylva_budget_decimal_text(committed_usd) AS committed_before_usd,
           public.pylva_budget_decimal_text(reserved_usd) AS reserved_before_usd,
           public.pylva_budget_decimal_text(unresolved_usd) AS unresolved_before_usd,
           public.pylva_budget_decimal_text(projected_usd) AS projected_usd,
           public.pylva_budget_decimal_text(limit_usd) AS limit_usd,
           public.pylva_budget_decimal_text(remaining_usd) AS remaining_usd,
           public.pylva_budget_decimal_text(
             MIN(remaining_usd) FILTER (WHERE enforcement = 'hard_stop') OVER ()
           ) AS hard_remaining_usd,
           exceeds_limit,
           committed_usd >= ${MAX_PUBLIC_BUDGET_EXCLUSIVE}::NUMERIC
             OR projected_usd >= ${MAX_PUBLIC_BUDGET_EXCLUSIVE}::NUMERIC
             AS public_range_overflow,
           version::TEXT AS account_version_before,
           jsonb_build_object(
             'schema_version', '1.0',
             'rule_key', rule_key::TEXT,
             'scope', scope,
             'subject_customer_id', subject_customer_id,
             'period', period,
             'period_start', public.pylva_budget_timestamp_text(period_start),
             'period_end', public.pylva_budget_timestamp_text(period_end),
             'enforcement', enforcement,
             'limit_usd', public.pylva_budget_decimal_text(limit_usd),
             'opening_committed_usd',
               public.pylva_budget_decimal_text(opening_committed_usd)
           ) AS rule_snapshot,
           public.pylva_budget_jsonb_sha256(jsonb_build_object(
             'schema_version', '1.0',
             'rule_key', rule_key::TEXT,
             'scope', scope,
             'subject_customer_id', subject_customer_id,
             'period', period,
             'period_start', public.pylva_budget_timestamp_text(period_start),
             'period_end', public.pylva_budget_timestamp_text(period_end),
             'enforcement', enforcement,
             'limit_usd', public.pylva_budget_decimal_text(limit_usd),
             'opening_committed_usd',
               public.pylva_budget_decimal_text(opening_committed_usd)
           )) AS rule_snapshot_hash
    FROM evaluated
    ORDER BY account_id
  `;
  return rows;
}

async function insertReservation(
  tx: TransactionSql,
  builderId: string,
  input: ReservationInsert,
): Promise<ReserveUsageResponse> {
  const request = input.request;
  const pricingSnapshot = input.pricing?.pricingSnapshot ?? null;
  const pricingSnapshotHash = input.pricing?.pricingSnapshotHash ?? null;
  const requestedUsd = input.pricing?.requestedUsd ?? null;
  const rows = await tx<{ reserve_response_snapshot: unknown }[]>`
    INSERT INTO public.budget_reservations (
      builder_id, decision_id, reservation_id, operation_id, schema_version,
      request_hash, request_snapshot, mode, kind, customer_id, trace_id, span_id,
      parent_span_id, step_name, framework, reservation_ttl_seconds,
      provider, model, estimated_input_tokens, max_output_tokens,
      cost_source_slug, tool_name, metric, maximum_value,
      decision, decision_reason, would_have_denied, state,
      pricing_snapshot, pricing_snapshot_hash, requested_usd, reserved_usd,
      actual_usd, released_usd, overage_usd, remaining_usd,
      deciding_account_id, reserve_response_snapshot,
      rule_revision_ids, rule_set_hash, authorization_transaction_id
    )
    VALUES (
      ${builderId}::UUID, ${input.decisionId}::UUID,
      ${input.reservationId}::UUID, ${request.operation_id}::UUID,
      ${BUDGET_CONTROL_SCHEMA_VERSION}, ${input.requestHash},
      ${pgJsonbParameterText(asJson(input.requestSnapshot))}::TEXT::JSONB,
      ${request.mode}, ${request.kind}, ${request.customer_id},
      ${request.trace_id}::UUID, ${request.span_id}::UUID,
      ${request.parent_span_id}::UUID, ${request.step_name}, ${request.framework},
      ${request.reservation_ttl_seconds},
      ${request.kind === 'llm' ? request.provider : null},
      ${request.kind === 'llm' ? request.model : null},
      ${request.kind === 'llm' ? request.estimated_input_tokens : null},
      ${request.kind === 'llm' ? request.max_output_tokens : null},
      ${request.kind === 'tool' ? request.cost_source_slug : null},
      ${request.kind === 'tool' ? request.tool_name : null},
      ${request.kind === 'tool' ? request.metric : null},
      ${request.kind === 'tool' ? request.maximum_value : null}::NUMERIC,
      ${input.decision}, ${input.decisionReason}, ${input.wouldHaveDenied},
      ${input.state},
      ${pricingSnapshot === null ? null : pgJsonbParameterText(asJson(pricingSnapshot))}::TEXT::JSONB,
      ${pricingSnapshotHash}, ${requestedUsd}::NUMERIC, ${input.reservedUsd}::NUMERIC,
      0, 0, 0, ${input.remainingUsd}::NUMERIC,
      ${input.decidingAccountId}::UUID,
      ${pgJsonbParameterText(asJson(input.reserveResponse))}::TEXT::JSONB,
      ARRAY[]::UUID[], ${ZERO_HASH}, 1
    )
    RETURNING reserve_response_snapshot
  `;
  const stored = rows[0]?.reserve_response_snapshot;
  if (stored === undefined) throw new Error('budget reservation insert returned no response');
  return assertStoredResponse(stored);
}

async function insertAllocation(
  tx: TransactionSql,
  builderId: string,
  decisionId: string,
  allocation: AllocationInsert,
): Promise<void> {
  const account = allocation.account;
  await tx`
    INSERT INTO public.budget_reservation_allocations (
      builder_id, reservation_decision_id, account_id, rule_key,
      rule_revision_id, rule_snapshot, rule_snapshot_hash, enforcement,
      evaluation_order, is_deciding, account_version_before, held_at_reserve,
      status, committed_before_usd, reserved_before_usd, unresolved_before_usd,
      requested_usd, projected_usd, limit_usd, remaining_usd, authorized_usd,
      actual_usd, released_usd, unresolved_usd, overage_usd
    )
    VALUES (
      ${builderId}::UUID, ${decisionId}::UUID, ${account.account_id}::UUID,
      ${account.rule_key}::UUID, ${account.rule_revision_id}::UUID,
      ${pgJsonbParameterText(asJson(account.rule_snapshot))}::TEXT::JSONB,
      ${account.rule_snapshot_hash},
      ${account.enforcement}, ${allocation.evaluationOrder}, ${allocation.isDeciding},
      ${account.account_version_before}::BIGINT, ${allocation.heldAtReserve},
      ${allocation.status}, ${account.committed_before_usd}::NUMERIC,
      ${account.reserved_before_usd}::NUMERIC,
      ${account.unresolved_before_usd}::NUMERIC, ${allocation.requestedUsd}::NUMERIC,
      ${account.projected_usd}::NUMERIC, ${account.limit_usd}::NUMERIC,
      ${account.remaining_usd}::NUMERIC, ${allocation.authorizedUsd}::NUMERIC,
      0, 0, 0, 0
    )
  `;
}

function warningsFor(accounts: LockedBudgetAccountRow[]): BudgetControlWarning[] {
  return accounts
    .filter((account) => account.enforcement === 'advisory' && account.exceeds_limit)
    .map((account) => ({
      code: BudgetControlWarningCode.ADVISORY_BUDGET_EXCEEDED,
      rule_id: account.rule_key,
      limit_usd: account.limit_usd,
      projected_usd: account.projected_usd,
    }));
}

async function persistUnevaluatedDecision(
  tx: TransactionSql,
  input: ReserveAuthorizationAttemptInput,
  requestHash: string,
  randomUUID: () => string,
  reason: 'pricing_unavailable' | 'usage_bound_required' | 'control_unavailable',
  retryable: boolean,
): Promise<ReserveUsageResponse> {
  const decisionId = randomUUID();
  const response =
    input.request.mode === BudgetControlMode.SHADOW
      ? shadowControlUnavailableResponse(input.request, decisionId)
      : unavailableResponse(input.request, decisionId, reason, retryable);
  return insertReservation(tx, input.builderId, {
    decision: input.request.mode === BudgetControlMode.SHADOW ? 'bypassed' : 'unavailable',
    decisionId,
    decisionReason:
      input.request.mode === BudgetControlMode.SHADOW
        ? BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE
        : reason,
    decidingAccountId: null,
    pricing: null,
    remainingUsd: null,
    request: input.request,
    requestHash,
    requestSnapshot: input.requestSnapshot,
    reservationId: null,
    reserveResponse: response,
    reservedUsd: '0',
    state: null,
    wouldHaveDenied: null,
  });
}

async function authorizeWithPostgres(
  input: ReserveAuthorizationAttemptInput,
  dependencies: {
    client?: Sql;
    randomUUID: () => string;
    resolvePricing: ResolveReservationPricing;
  },
): Promise<ReserveUsageResponse> {
  return withBudgetControlTransaction(
    input.builderId,
    async (tx) => {
      const requestHash = await pgCanonicalJsonbSha256(tx, asJson(input.requestSnapshot));
      await acquireBudgetOperationLock(tx, input.builderId, input.request.operation_id);
      const replay = await replayIfPresent(
        tx,
        input.builderId,
        input.request.operation_id,
        requestHash,
      );
      if (replay) return replay;

      // This explicit lock precedes every current revision read. Reservation
      // INSERT takes the same shared lock again in migration 050.
      await acquireBudgetBuilderSharedLock(tx, input.builderId);
      // Account preparation is intentionally a separate narrow transaction,
      // but authorization independently re-proves typed readiness under the
      // shared builder lock. A missing/pending/stale cutover must never be
      // mislabeled as no_applicable_budget, even when there are no rules.
      if (!(await builderControlIsReady(tx, input.builderId))) {
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          false,
        );
      }
      const revisionIds = await activeRevisionIds(tx, input.builderId, input.request.customer_id);
      if (revisionIds.length === 0) {
        const decisionId = dependencies.randomUUID();
        const response = noApplicableBudgetResponse(input.request, decisionId);
        return insertReservation(tx, input.builderId, {
          decision: 'bypassed',
          decisionId,
          decisionReason: BudgetBypassReason.NO_APPLICABLE_BUDGET,
          decidingAccountId: null,
          pricing: null,
          remainingUsd: null,
          request: input.request,
          requestHash,
          requestSnapshot: input.requestSnapshot,
          reservationId: null,
          reserveResponse: response,
          reservedUsd: '0',
          state: null,
          wouldHaveDenied: null,
        });
      }

      const pricingOutput: unknown = await dependencies.resolvePricing({
        tx,
        builderId: input.builderId,
        usage: pricingUsage(input.request),
      });
      if (!isRecord(pricingOutput) || pricingOutput.available === false) {
        if (
          !isRecord(pricingOutput) ||
          pricingOutput.reason !== 'pricing_unavailable' ||
          !isPricingUnavailableCause(pricingOutput.cause)
        ) {
          return persistUnevaluatedDecision(
            tx,
            input,
            requestHash,
            dependencies.randomUUID,
            BudgetUnavailableReason.CONTROL_UNAVAILABLE,
            false,
          );
        }
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          unavailableReasonForPricingCause(pricingOutput.cause),
          false,
        );
      }

      if (pricingOutput.available !== true) {
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          false,
        );
      }

      const requested = v.safeParse(CanonicalDecimalSchema, pricingOutput.requested_usd);
      if (!requested.success || requested.output !== pricingOutput.requested_usd) {
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          false,
        );
      }
      if (
        !isBoundedJsonObject(pricingOutput.pricing_snapshot) ||
        typeof pricingOutput.pricing_snapshot_hash !== 'string' ||
        !SHA256_PATTERN.test(pricingOutput.pricing_snapshot_hash)
      ) {
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          false,
        );
      }
      const computedPricingHash = await pgCanonicalJsonbSha256(
        tx,
        asJson(pricingOutput.pricing_snapshot),
      );
      if (computedPricingHash !== pricingOutput.pricing_snapshot_hash) {
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          false,
        );
      }

      const priced: PricedReservation = {
        pricingSnapshot: pricingOutput.pricing_snapshot,
        pricingSnapshotHash: pricingOutput.pricing_snapshot_hash,
        requestedUsd: requested.output,
      };
      const accounts = await lockedCurrentAccounts(
        tx,
        input.builderId,
        input.request.customer_id,
        revisionIds,
        priced.requestedUsd,
      );
      const observedRevisionIds = accounts.map((account) => account.rule_revision_id).sort();
      if (
        accounts.length !== revisionIds.length ||
        observedRevisionIds.some((id, index) => id !== revisionIds[index])
      ) {
        throw new MissingBudgetAccountClosureError();
      }
      if (accounts.some((account) => account.public_range_overflow)) {
        return persistUnevaluatedDecision(
          tx,
          input,
          requestHash,
          dependencies.randomUUID,
          BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          false,
        );
      }

      const warnings = warningsFor(accounts);
      const hardViolations = accounts.filter(
        (account) => account.enforcement === 'hard_stop' && account.exceeds_limit,
      );
      const deciding = hardViolations[0] ?? null;
      const decisionId = dependencies.randomUUID();

      if (input.request.mode === BudgetControlMode.SHADOW) {
        const response: ReserveUsageResponse = deciding
          ? {
              schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
              decision: ReserveDecision.BYPASSED,
              allowed: true,
              decision_id: decisionId,
              operation_id: input.request.operation_id,
              reason: BudgetBypassReason.SHADOW_WOULD_DENY,
              would_have_denied: true,
              warnings,
            }
          : {
              schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
              decision: ReserveDecision.BYPASSED,
              allowed: true,
              decision_id: decisionId,
              operation_id: input.request.operation_id,
              reason: BudgetBypassReason.SHADOW_WOULD_ALLOW,
              would_have_denied: false,
              warnings,
            };
        await insertReservation(tx, input.builderId, {
          decision: 'bypassed',
          decisionId,
          decisionReason: response.reason,
          decidingAccountId: deciding?.account_id ?? null,
          pricing: priced,
          remainingUsd: null,
          request: input.request,
          requestHash,
          requestSnapshot: input.requestSnapshot,
          reservationId: null,
          reserveResponse: response,
          reservedUsd: '0',
          state: null,
          wouldHaveDenied: response.would_have_denied,
        });
        for (const [index, account] of accounts.entries()) {
          await insertAllocation(tx, input.builderId, decisionId, {
            account,
            authorizedUsd: '0',
            evaluationOrder: index,
            heldAtReserve: false,
            isDeciding: account.account_id === deciding?.account_id,
            requestedUsd: priced.requestedUsd,
            status: 'shadow',
          });
        }
        return response;
      }

      if (deciding) {
        const ruleCommon = {
          rule_id: deciding.rule_key,
          period: deciding.period,
          period_start: deciding.period_start,
          period_end: deciding.period_end,
        };
        const decidingRule =
          deciding.scope === 'pooled'
            ? { ...ruleCommon, scope: 'pooled' as const, customer_id: null }
            : {
                ...ruleCommon,
                scope: 'per_customer' as const,
                customer_id:
                  deciding.subject_customer_id ??
                  (() => {
                    throw new Error('per-customer budget account has no customer identity');
                  })(),
              };
        const response: ReserveUsageResponse = {
          schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
          decision: ReserveDecision.DENIED,
          allowed: false,
          decision_id: decisionId,
          operation_id: input.request.operation_id,
          state: BudgetReservationState.REFUSED,
          deciding_rule: decidingRule,
          committed_usd: deciding.committed_before_usd,
          reserved_usd: deciding.reserved_before_usd,
          unresolved_usd: deciding.unresolved_before_usd,
          requested_usd: priced.requestedUsd,
          limit_usd: deciding.limit_usd,
          remaining_usd: deciding.remaining_usd,
          warnings,
        };
        await insertReservation(tx, input.builderId, {
          decision: 'denied',
          decisionId,
          decisionReason: 'budget_exceeded',
          decidingAccountId: deciding.account_id,
          pricing: priced,
          remainingUsd: deciding.remaining_usd,
          request: input.request,
          requestHash,
          requestSnapshot: input.requestSnapshot,
          reservationId: null,
          reserveResponse: response,
          reservedUsd: '0',
          state: 'refused',
          wouldHaveDenied: null,
        });
        for (const [index, account] of accounts.entries()) {
          const refused = account.enforcement === 'hard_stop' && account.exceeds_limit;
          await insertAllocation(tx, input.builderId, decisionId, {
            account,
            authorizedUsd: '0',
            evaluationOrder: index,
            heldAtReserve: false,
            isDeciding: account.account_id === deciding.account_id,
            requestedUsd: priced.requestedUsd,
            status: refused ? 'refused' : 'not_held',
          });
        }
        return response;
      }

      const reservationId = dependencies.randomUUID();
      const response: ReserveUsageResponse = {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        decision: ReserveDecision.RESERVED,
        allowed: true,
        decision_id: decisionId,
        operation_id: input.request.operation_id,
        reservation_id: reservationId,
        state: BudgetReservationState.RESERVED,
        reserved_usd: priced.requestedUsd,
        remaining_usd: accounts[0]?.hard_remaining_usd ?? null,
        expires_at: PLACEHOLDER_EXPIRES_AT,
        warnings,
      };
      const storedResponse = await insertReservation(tx, input.builderId, {
        decision: 'reserved',
        decisionId,
        decisionReason: null,
        decidingAccountId: null,
        pricing: priced,
        remainingUsd: accounts[0]?.hard_remaining_usd ?? null,
        request: input.request,
        requestHash,
        requestSnapshot: input.requestSnapshot,
        reservationId,
        reserveResponse: response,
        reservedUsd: priced.requestedUsd,
        state: 'reserved',
        wouldHaveDenied: null,
      });
      for (const [index, account] of accounts.entries()) {
        await insertAllocation(tx, input.builderId, decisionId, {
          account,
          authorizedUsd: priced.requestedUsd,
          evaluationOrder: index,
          heldAtReserve: true,
          isDeciding: false,
          requestedUsd: priced.requestedUsd,
          status: 'reserved',
        });
      }
      return storedResponse;
    },
    { client: dependencies.client, maxAttempts: 1 },
  );
}

async function persistControlFailureWithPostgres(
  input: ReserveAuthorizationAttemptInput,
  dependencies: { client?: Sql; randomUUID: () => string },
): Promise<ReserveUsageResponse> {
  return withBudgetControlTransaction(
    input.builderId,
    async (tx) => {
      const requestHash = await pgCanonicalJsonbSha256(tx, asJson(input.requestSnapshot));
      await acquireBudgetOperationLock(tx, input.builderId, input.request.operation_id);
      const replay = await replayIfPresent(
        tx,
        input.builderId,
        input.request.operation_id,
        requestHash,
      );
      if (replay) return replay;
      await acquireBudgetBuilderSharedLock(tx, input.builderId);
      return persistUnevaluatedDecision(
        tx,
        input,
        requestHash,
        dependencies.randomUUID,
        BudgetUnavailableReason.CONTROL_UNAVAILABLE,
        input.controlFailureRetryable ?? true,
      );
    },
    { client: dependencies.client },
  );
}

async function defaultControlEnabled(): Promise<boolean> {
  const { env } = await import('../config.js');
  return env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL;
}

async function defaultAccountMaterializer(
  input: EnsureBudgetAccountsMaterializedInput,
  client?: Sql,
): Promise<void> {
  // Lazy loading keeps the kill-switch path independent of the ledger and
  // avoids pulling database-only modules into callers that inject a service.
  const { ensureBudgetAccountsMaterialized } = await import('./accounts.js');
  if (client) {
    await ensureBudgetAccountsMaterialized(input, { client });
  } else {
    await ensureBudgetAccountsMaterialized(input);
  }
}

export function createReserveBudgetUsage(
  dependencies: ReserveBudgetUsageDependencies = {},
): (
  builderId: string,
  parsedRequest: ParsedReserveUsageRequest,
  sdkIdentity?: BudgetControlSdkIdentity,
) => Promise<ReserveUsageResponse> {
  const controlEnabled = dependencies.controlEnabled ?? defaultControlEnabled;
  const ensureBudgetAccountsMaterialized =
    dependencies.ensureBudgetAccountsMaterialized ??
    ((input: EnsureBudgetAccountsMaterializedInput) =>
      defaultAccountMaterializer(input, dependencies.client));
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());
  const resolvePricing = dependencies.resolvePricing ?? resolveAuthoritativePricing;
  const sleep = dependencies.sleep ?? defaultSleep;
  const maxAttempts = validateMaxAttempts(dependencies.maxAttempts ?? DEFAULT_RESERVATION_ATTEMPTS);
  const authorizeAttempt =
    dependencies.authorizeAttempt ??
    ((input: ReserveAuthorizationAttemptInput) =>
      authorizeWithPostgres(input, {
        client: dependencies.client,
        randomUUID,
        resolvePricing,
      }));
  const persistControlFailure =
    dependencies.persistControlFailure ??
    ((input: ReserveAuthorizationAttemptInput) =>
      persistControlFailureWithPostgres(input, {
        client: dependencies.client,
        randomUUID,
      }));

  return async (builderId, parsedRequest, sdkIdentity) => {
    if (!(await controlEnabled())) return controlDisabledResponse(parsedRequest);

    const input: ReserveAuthorizationAttemptInput = {
      builderId,
      request: parsedRequest,
      requestSnapshot: canonicalReserveRequestSnapshot(parsedRequest),
      sdkIdentity,
    };
    let controlFailureRetryable = true;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // This finishes before authorizeAttempt opens its READ COMMITTED
        // transaction. Never move materialization into the shared-lock tx.
        await ensureBudgetAccountsMaterialized({
          builderId,
          customerId: parsedRequest.customer_id,
        });
        return await authorizeAttempt(input);
      } catch (error) {
        if (isIdempotencyConflict(error)) throw error;
        controlFailureRetryable = deterministicControlFailureRetryability(error) ?? true;
        const classification = classifyBudgetTransactionError(error);
        if (!classification.retryable || attempt >= maxAttempts) break;
        // A classified fresh-transaction failure is operationally transient,
        // even if it happened after a deterministic prerequisite succeeded.
        controlFailureRetryable = true;
        await sleep(budgetTransactionRetryDelayMs(attempt));
      }
    }

    // A best-effort durable fail-closed decision also closes lost-commit-ack
    // races: its operation lock replays a decision that may already have won.
    try {
      return await persistControlFailure({
        ...input,
        controlFailureRetryable,
      });
    } catch (error) {
      if (isIdempotencyConflict(error)) throw error;
      return ephemeralControlFailureResponse(parsedRequest);
    }
  };
}

const defaultReserveBudgetUsage = createReserveBudgetUsage();

export async function reserveBudgetUsage(
  builderId: string,
  parsedRequest: ParsedReserveUsageRequest,
  sdkIdentity?: BudgetControlSdkIdentity,
): Promise<ReserveUsageResponse> {
  return defaultReserveBudgetUsage(builderId, parsedRequest, sdkIdentity);
}
