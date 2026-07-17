import crypto from 'node:crypto';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetReleaseReason,
  ErrorCode,
  billingRetentionDays,
  isBuilderTier,
  telemetryRetentionDays,
  RETENTION_FALLBACK_DAYS,
  type CommitUsageResponse,
  type ExtendUsageRequest,
  type ExtendUsageResponse,
  type ParsedCommitUsageRequest,
  type ReleaseUsageRequest,
  type ReleaseUsageResponse,
} from '@pylva/shared';
import type { BudgetControlSdkIdentity } from './sdk-identity.js';
import {
  priceAuthoritativeUsage,
  type AuthoritativePricingUnavailableCause,
  type AuthoritativeUsagePriceResult,
  type PriceAuthoritativeUsageInput,
} from './pricing.js';
import {
  acquireBudgetBuilderSharedLock,
  pgCanonicalJsonbSha256,
  pgJsonbParameterText,
  type BudgetTransactionOptions,
  withBudgetControlTransaction,
} from './transaction.js';

/**
 * Lifecycle writes are deliberately kept in one module. Nothing in this file
 * dispatches a provider request or performs another external side effect.
 * PostgreSQL is the sole lifecycle, pricing-snapshot, and billing authority.
 */

const DECIMAL_SCALE = 18;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);
const NUMERIC_38_18_UNITS_LIMIT = 10n ** 38n;
const NUMERIC_44_18_UNITS_LIMIT = 10n ** 44n;
const DEFAULT_EXPIRY_BATCH_LIMIT = 100;
const MAX_EXPIRY_BATCH_LIMIT = 1_000;

const NONNEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/;

type ReservationState = 'reserved' | 'committed' | 'released' | 'unresolved';
type TransitionType = 'commit' | 'release' | 'extend' | 'expire_unresolved';

interface JsonObject {
  [key: string]: postgres.JSONValue | undefined;
}

interface LockedReservation {
  billingTier: string;
  costSourceSlug: string | null;
  customerId: string;
  decisionId: string;
  expiresAt: string;
  framework: string;
  kind: 'llm' | 'tool';
  metric: string | null;
  model: string | null;
  operationId: string;
  parentSpanId: string | null;
  pricingSnapshot: JsonObject;
  pricingSnapshotHash: string;
  provider: string | null;
  reservationId: string;
  reservedUsd: string;
  spanId: string;
  state: ReservationState;
  stateVersion: bigint;
  stepName: string | null;
  toolName: string | null;
  traceId: string;
}

interface TransitionReplayRow {
  requestHash: string;
  responseSnapshot: JsonObject;
}

interface ExpiryTransitionResult {
  fromExpiresAt: string;
  fromStateVersion: bigint;
  operationId: string;
  reservationId: string;
  reservedUsd: string;
  unresolvedAt: string;
}

interface CommitParentResult {
  committedAt: string;
}

interface ReleaseParentResult {
  releasedAt: string;
}

interface ExtendParentResult {
  extendedAt: string;
  expiresAt: string;
}

class BudgetLifecycleLeaseBoundaryRetryError extends Error {
  constructor() {
    super('Reservation crossed its lease boundary during terminal settlement');
    this.name = 'BudgetLifecycleLeaseBoundaryRetryError';
  }
}

const EXTENSION_LEASE_BOUNDARY_DATABASE_MESSAGE = 'only a live reservation lease may be extended';

export type BudgetLifecycleErrorCode =
  | typeof ErrorCode.RESOURCE_NOT_FOUND
  | typeof ErrorCode.IDEMPOTENCY_CONFLICT
  | typeof ErrorCode.RESERVATION_STATE_CONFLICT
  | typeof ErrorCode.INTERNAL_ERROR;

export class BudgetLifecycleError extends Error {
  readonly code: BudgetLifecycleErrorCode;
  readonly status: number;

  constructor(status: number, code: BudgetLifecycleErrorCode, message: string) {
    super(message);
    this.name = 'BudgetLifecycleError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Raised before mutation when a mathematically valid v1 settlement needs the
 * NUMERIC(44,18) columns introduced after migration 050, but the connected
 * database still exposes only NUMERIC(38,18). The caller must surface this as
 * an operational readiness failure; it must never truncate or drop the cost.
 */
export class BudgetLifecycleSchemaBlockerError extends BudgetLifecycleError {
  readonly actualUsd: string;

  constructor(actualUsd: string, message = 'Budget ledger is not ready for widened actual cost') {
    super(503, ErrorCode.INTERNAL_ERROR, message);
    this.name = 'BudgetLifecycleSchemaBlockerError';
    this.actualUsd = actualUsd;
  }
}

/**
 * A frozen snapshot that cannot authoritatively price post-provider usage is a
 * service-readiness failure, never permission to guess, truncate, or release
 * the hold. The HTTP boundary intentionally sanitizes this internal cause.
 */
export class BudgetLifecyclePricingUnavailableError extends BudgetLifecycleError {
  readonly cause: AuthoritativePricingUnavailableCause;

  constructor(cause: AuthoritativePricingUnavailableCause) {
    super(503, ErrorCode.INTERNAL_ERROR, 'Frozen authoritative pricing is unavailable');
    this.name = 'BudgetLifecyclePricingUnavailableError';
    this.cause = cause;
  }
}

export interface ExpireDueBudgetReservationsResult {
  expired: number;
}

export interface BudgetLifecycleService {
  commitBudgetUsage(
    builderId: string,
    reservationId: string,
    parsedRequest: ParsedCommitUsageRequest,
    sdkIdentity: BudgetControlSdkIdentity,
  ): Promise<CommitUsageResponse>;
  releaseBudgetUsage(
    builderId: string,
    reservationId: string,
    parsedRequest: ReleaseUsageRequest,
    sdkIdentity: BudgetControlSdkIdentity,
  ): Promise<ReleaseUsageResponse>;
  extendBudgetUsage(
    builderId: string,
    reservationId: string,
    parsedRequest: ExtendUsageRequest,
    sdkIdentity: BudgetControlSdkIdentity,
  ): Promise<ExtendUsageResponse>;
  expireDueBudgetReservations(
    builderId: string,
    limit?: number,
  ): Promise<ExpireDueBudgetReservationsResult>;
}

export interface BudgetLifecycleServiceDependencies {
  /** Scratch/test clients can be injected without changing production calls. */
  transactionOptions?: BudgetTransactionOptions;
  randomUUID?: () => string;
}

interface PricingContext {
  costSourceSlug: string | null;
  kind: 'llm' | 'tool';
  metric: string | null;
  model: string | null;
  pricingSnapshot: JsonObject;
  provider: string | null;
}

type AuthoritativeUsagePricer = (
  input: PriceAuthoritativeUsageInput,
) => Promise<AuthoritativeUsagePriceResult>;

export interface BudgetSettlementAmounts {
  actualUsd: string;
  overageUsd: string;
  releasedUsd: string;
  reservedUsd: string;
}

function lifecycleError(
  status: number,
  code: BudgetLifecycleErrorCode,
  message: string,
): BudgetLifecycleError {
  return new BudgetLifecycleError(status, code, message);
}

function notFound(): BudgetLifecycleError {
  return lifecycleError(404, ErrorCode.RESOURCE_NOT_FOUND, 'Reservation not found');
}

function idempotencyConflict(): BudgetLifecycleError {
  return lifecycleError(
    409,
    ErrorCode.IDEMPOTENCY_CONFLICT,
    'The lifecycle idempotency identity was already used with a different request',
  );
}

function stateConflict(state: string): BudgetLifecycleError {
  return lifecycleError(
    409,
    ErrorCode.RESERVATION_STATE_CONFLICT,
    `Reservation cannot perform this transition from state ${state}`,
  );
}

function integrityFailure(message: string): BudgetLifecycleError {
  return lifecycleError(500, ErrorCode.INTERNAL_ERROR, message);
}

function requireJsonObject(value: postgres.JSONValue, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw integrityFailure(`${name} is not a JSON object`);
  }
  return value as JsonObject;
}

function decimalUnits(value: string, field: string): bigint {
  if (!NONNEGATIVE_DECIMAL_PATTERN.test(value)) {
    throw integrityFailure(`${field} is not a canonical nonnegative decimal`);
  }
  const [integerPart = '0', fractionalPart = ''] = value.split('.');
  return BigInt(integerPart) * DECIMAL_FACTOR + BigInt(fractionalPart.padEnd(DECIMAL_SCALE, '0'));
}

function decimalText(units: bigint): string {
  if (units < 0n) throw integrityFailure('A budget amount became negative');
  const integerPart = units / DECIMAL_FACTOR;
  const fractionalPart = (units % DECIMAL_FACTOR)
    .toString()
    .padStart(DECIMAL_SCALE, '0')
    .replace(/0+$/, '');
  return fractionalPart.length === 0 ? integerPart.toString() : `${integerPart}.${fractionalPart}`;
}

/**
 * Prices actual usage through the same PostgreSQL frozen-snapshot evaluator as
 * reserve. That evaluator supports flat and volume prices, validates the
 * canonical snapshot/hash, and applies one conservative ceiling after exact
 * arithmetic. Client-supplied dollar values are never accepted.
 */
export async function priceActualUsageFromFrozenPricing(
  transaction: TransactionSql,
  context: PricingContext,
  pricingSnapshotHash: string,
  request: ParsedCommitUsageRequest,
  pricer: AuthoritativeUsagePricer = priceAuthoritativeUsage,
): Promise<string> {
  const snapshot = context.pricingSnapshot;
  if (request.kind !== context.kind) {
    throw lifecycleError(
      409,
      ErrorCode.RESERVATION_STATE_CONFLICT,
      'Commit usage kind does not match the reservation',
    );
  }
  const identityMatches =
    request.kind === 'llm'
      ? context.provider !== null &&
        context.model !== null &&
        snapshot['kind'] === 'llm' &&
        snapshot['provider'] === context.provider &&
        snapshot['model'] === context.model
      : context.costSourceSlug !== null &&
        context.metric !== null &&
        snapshot['kind'] === 'tool' &&
        snapshot['cost_source_slug'] === context.costSourceSlug &&
        snapshot['metric'] === context.metric;
  if (!identityMatches) {
    throw integrityFailure(
      `Frozen ${request.kind} pricing identity does not match the reservation`,
    );
  }

  const priced = await pricer({
    tx: transaction,
    pricing_snapshot: snapshot,
    pricing_snapshot_hash: pricingSnapshotHash,
    usage:
      request.kind === 'llm'
        ? {
            kind: 'llm',
            input_tokens: request.actual_input_tokens,
            output_tokens: request.actual_output_tokens,
          }
        : { kind: 'tool', value: request.actual_value },
    amount_kind: 'actual',
  });
  if (!priced.available) throw new BudgetLifecyclePricingUnavailableError(priced.cause);
  return priced.cost_usd;
}

export function calculateBudgetSettlement(
  reservedUsd: string,
  actualUsd: string,
): BudgetSettlementAmounts {
  const reserved = decimalUnits(reservedUsd, 'reserved_usd');
  const actual = decimalUnits(actualUsd, 'actual_usd');
  const released = reserved > actual ? reserved - actual : 0n;
  const overage = actual > reserved ? actual - reserved : 0n;
  return {
    reservedUsd: decimalText(reserved),
    actualUsd: decimalText(actual),
    releasedUsd: decimalText(released),
    overageUsd: decimalText(overage),
  };
}

function jsonValue(value: object): postgres.JSONValue {
  return value as unknown as postgres.JSONValue;
}

function replayResponse<T extends { idempotent_replay: boolean }>(snapshot: JsonObject): T {
  return { ...snapshot, idempotent_replay: true } as unknown as T;
}

function rowStateVersion(value: string | number | bigint): bigint {
  try {
    return BigInt(value);
  } catch {
    throw integrityFailure('Reservation state version is not an integer');
  }
}

function terminalTimestampAtOrAfterExpiry(timestamp: string, expiresAt: string | Date): boolean {
  const timestampMs = Date.parse(timestamp);
  const expiresAtMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
  if (!Number.isFinite(timestampMs) || !Number.isFinite(expiresAtMs)) {
    throw integrityFailure('Lifecycle timestamp is not a valid instant');
  }
  return timestampMs >= expiresAtMs;
}

function ownErrorString(error: unknown, field: 'code' | 'message'): string | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !Object.prototype.hasOwnProperty.call(error, field)
  ) {
    return null;
  }
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function isExtensionLeaseBoundaryDatabaseError(error: unknown): boolean {
  let selected = error;
  if (ownErrorString(selected, 'code') === null) {
    selected =
      typeof error === 'object' &&
      error !== null &&
      Object.prototype.hasOwnProperty.call(error, 'cause')
        ? (error as { cause?: unknown }).cause
        : undefined;
  }
  return (
    ownErrorString(selected, 'code') === '55000' &&
    ownErrorString(selected, 'message') === EXTENSION_LEASE_BOUNDARY_DATABASE_MESSAGE
  );
}

async function lockReservation(
  transaction: TransactionSql,
  builderId: string,
  reservationId: string,
): Promise<LockedReservation | null> {
  const rows = await transaction<
    {
      billing_tier: string;
      cost_source_slug: string | null;
      customer_id: string;
      decision_id: string;
      expires_at: string | null;
      framework: string;
      kind: 'llm' | 'tool';
      metric: string | null;
      model: string | null;
      operation_id: string;
      parent_span_id: string | null;
      pricing_snapshot: postgres.JSONValue | null;
      pricing_snapshot_hash: string | null;
      provider: string | null;
      reservation_id: string | null;
      reserved_usd: string;
      span_id: string;
      state: ReservationState | null;
      state_version: string;
      step_name: string | null;
      tool_name: string | null;
      trace_id: string;
    }[]
  >`
    SELECT builder.tier AS billing_tier,
           reservation.cost_source_slug,
           reservation.customer_id,
           reservation.decision_id,
           CASE WHEN reservation.expires_at IS NULL THEN NULL
             ELSE public.pylva_budget_timestamp_text(reservation.expires_at)
           END AS expires_at,
           reservation.framework,
           reservation.kind,
           reservation.metric,
           reservation.model,
           reservation.operation_id,
           reservation.parent_span_id,
           reservation.pricing_snapshot,
           reservation.pricing_snapshot_hash,
           reservation.provider,
           reservation.reservation_id,
           reservation.reserved_usd::TEXT AS reserved_usd,
           reservation.span_id,
           reservation.state,
           reservation.state_version::TEXT AS state_version,
           reservation.step_name,
           reservation.tool_name,
           reservation.trace_id
    FROM public.budget_reservations reservation
    JOIN public.builders builder ON builder.id = reservation.builder_id
    WHERE reservation.builder_id = ${builderId}::UUID
      AND reservation.reservation_id = ${reservationId}::UUID
      AND reservation.decision = 'reserved'
    FOR UPDATE OF reservation
  `;
  const row = rows[0];
  if (!row) return null;
  if (
    row.reservation_id === null ||
    row.expires_at === null ||
    row.state === null ||
    row.pricing_snapshot === null ||
    row.pricing_snapshot_hash === null
  ) {
    throw integrityFailure('Held reservation is missing authoritative lifecycle or pricing data');
  }
  return {
    billingTier: row.billing_tier,
    costSourceSlug: row.cost_source_slug,
    customerId: row.customer_id,
    decisionId: row.decision_id,
    expiresAt: row.expires_at,
    framework: row.framework,
    kind: row.kind,
    metric: row.metric,
    model: row.model,
    operationId: row.operation_id,
    parentSpanId: row.parent_span_id,
    pricingSnapshot: requireJsonObject(row.pricing_snapshot, 'pricing_snapshot'),
    pricingSnapshotHash: row.pricing_snapshot_hash,
    provider: row.provider,
    reservationId: row.reservation_id,
    reservedUsd: row.reserved_usd,
    spanId: row.span_id,
    state: row.state,
    stateVersion: rowStateVersion(row.state_version),
    stepName: row.step_name,
    toolName: row.tool_name,
    traceId: row.trace_id,
  };
}

async function existingTransition(
  transaction: TransactionSql,
  builderId: string,
  decisionId: string,
  type: TransitionType,
  extensionId: string | null,
): Promise<TransitionReplayRow | null> {
  const rows = await transaction<
    {
      request_hash: string;
      response_snapshot: postgres.JSONValue;
    }[]
  >`
    SELECT request_hash, response_snapshot
    FROM public.budget_reservation_transitions
    WHERE builder_id = ${builderId}::UUID
      AND reservation_decision_id = ${decisionId}::UUID
      AND type = ${type}
      AND extension_id IS NOT DISTINCT FROM ${extensionId}::UUID
    LIMIT 1
  `;
  const row = rows[0];
  return row
    ? {
        requestHash: row.request_hash,
        responseSnapshot: requireJsonObject(row.response_snapshot, 'response_snapshot'),
      }
    : null;
}

async function lockAllocationAccounts(
  transaction: TransactionSql,
  builderId: string,
  decisionId: string,
): Promise<number> {
  const rows = await transaction<{ id: string }[]>`
    SELECT account.id
    FROM public.budget_accounts account
    JOIN public.budget_reservation_allocations allocation
      ON allocation.builder_id = account.builder_id
     AND allocation.account_id = account.id
    WHERE allocation.builder_id = ${builderId}::UUID
      AND allocation.reservation_decision_id = ${decisionId}::UUID
      AND allocation.held_at_reserve
    ORDER BY account.id ASC
    FOR UPDATE OF account
  `;
  if (rows.length === 0) {
    throw integrityFailure('Held reservation has no allocation accounts');
  }
  return rows.length;
}

async function runtimeSupportsWideActualAmounts(transaction: TransactionSql): Promise<boolean> {
  const rows = await transaction<{ ready: boolean }[]>`
    WITH required(table_name, column_name) AS (
      VALUES
        ('budget_reservations', 'actual_usd'),
        ('budget_reservations', 'overage_usd'),
        ('budget_reservation_allocations', 'actual_usd'),
        ('budget_reservation_allocations', 'overage_usd'),
        ('budget_usage_ledger', 'actual_cost_usd')
    ), observed AS (
      SELECT required.table_name,
             required.column_name,
             column_info.numeric_precision,
             column_info.numeric_scale
      FROM required
      LEFT JOIN information_schema.columns column_info
        ON column_info.table_schema = 'public'
       AND column_info.table_name = required.table_name
       AND column_info.column_name = required.column_name
    )
    SELECT COUNT(numeric_precision) = 5
      AND BOOL_AND(numeric_precision >= 44 AND numeric_scale = 18) AS ready
    FROM observed
  `;
  return rows[0]?.ready === true;
}

async function assertRuntimeAmountCapacity(
  transaction: TransactionSql,
  actualUsd: string,
): Promise<void> {
  if (decimalUnits(actualUsd, 'actual_usd') < NUMERIC_38_18_UNITS_LIMIT) return;
  if (!(await runtimeSupportsWideActualAmounts(transaction))) {
    throw new BudgetLifecycleSchemaBlockerError(actualUsd);
  }
}

async function expireIfDue(
  transaction: TransactionSql,
  builderId: string,
  reservation: LockedReservation,
  allocationCount: number,
  randomUUID: () => string,
): Promise<LockedReservation> {
  if (reservation.state !== 'reserved') return reservation;
  const rows = await transaction<
    {
      expires_at: string;
      operation_id: string;
      reservation_id: string;
      reserved_usd: string;
      state_version: string;
      unresolved_at: string;
    }[]
  >`
    UPDATE public.budget_reservations
    SET state = 'unresolved',
        unresolved_reason = 'lease_expired',
        state_version = state_version + 1
    WHERE builder_id = ${builderId}::UUID
      AND decision_id = ${reservation.decisionId}::UUID
      AND state = 'reserved'
      AND expires_at <= pg_catalog.clock_timestamp()
    RETURNING public.pylva_budget_timestamp_text(expires_at) AS expires_at,
              operation_id,
              reservation_id,
              reserved_usd::TEXT AS reserved_usd,
              state_version::TEXT AS state_version,
              public.pylva_budget_timestamp_text(unresolved_at) AS unresolved_at
  `;
  const updated = rows[0];
  if (!updated) return reservation;

  const allocationRows = await transaction<{ id: string }[]>`
    UPDATE public.budget_reservation_allocations
    SET status = 'unresolved',
        actual_usd = 0,
        released_usd = 0,
        unresolved_usd = authorized_usd,
        overage_usd = 0
    WHERE builder_id = ${builderId}::UUID
      AND reservation_decision_id = ${reservation.decisionId}::UUID
      AND status = 'reserved'
    RETURNING id
  `;
  if (allocationRows.length !== allocationCount) {
    throw integrityFailure('Expiry did not transition every held allocation');
  }

  const transition: ExpiryTransitionResult = {
    fromExpiresAt: reservation.expiresAt,
    fromStateVersion: reservation.stateVersion,
    operationId: updated.operation_id,
    reservationId: updated.reservation_id,
    reservedUsd: decimalText(decimalUnits(updated.reserved_usd, 'reserved_usd')),
    unresolvedAt: updated.unresolved_at,
  };
  const requestSnapshot = {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    reason: 'lease_expired',
  };
  const requestHash = await pgCanonicalJsonbSha256(transaction, jsonValue(requestSnapshot));
  const responseSnapshot = {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    state: 'unresolved',
    reservation_id: transition.reservationId,
    operation_id: transition.operationId,
    unresolved_usd: transition.reservedUsd,
    unresolved_at: transition.unresolvedAt,
    reason: 'lease_expired',
  };
  await transaction`
    INSERT INTO public.budget_reservation_transitions (
      builder_id, id, reservation_decision_id, type, extension_id, release_reason,
      request_hash, request_snapshot, response_snapshot,
      from_state, to_state, from_state_version, to_state_version,
      from_expires_at, to_expires_at, extend_by_seconds
    )
    VALUES (
      ${builderId}::UUID, ${randomUUID()}::UUID, ${reservation.decisionId}::UUID,
      'expire_unresolved', NULL, NULL,
      ${requestHash}, ${pgJsonbParameterText(jsonValue(requestSnapshot))}::TEXT::JSONB,
      ${pgJsonbParameterText(jsonValue(responseSnapshot))}::TEXT::JSONB,
      'reserved', 'unresolved', ${transition.fromStateVersion.toString()},
      ${(transition.fromStateVersion + 1n).toString()}, ${transition.fromExpiresAt},
      ${transition.fromExpiresAt}, NULL
    )
  `;

  return {
    ...reservation,
    state: 'unresolved',
    stateVersion: rowStateVersion(updated.state_version),
  };
}

function retentionForTier(tier: string): { billing: number; telemetry: number } {
  if (!isBuilderTier(tier)) {
    return { billing: RETENTION_FALLBACK_DAYS, telemetry: RETENTION_FALLBACK_DAYS };
  }
  return {
    billing: billingRetentionDays(tier),
    telemetry: telemetryRetentionDays(tier),
  };
}

async function commitWithinTransaction(
  transaction: TransactionSql,
  builderId: string,
  reservationId: string,
  parsedRequest: ParsedCommitUsageRequest,
  sdkIdentity: BudgetControlSdkIdentity,
  randomUUID: () => string,
): Promise<CommitUsageResponse> {
  let reservation = await lockReservation(transaction, builderId, reservationId);
  if (!reservation) throw notFound();

  const requestSnapshot = parsedRequest as unknown as JsonObject;
  const requestHash = await pgCanonicalJsonbSha256(transaction, jsonValue(requestSnapshot));
  const replay = await existingTransition(
    transaction,
    builderId,
    reservation.decisionId,
    'commit',
    null,
  );
  if (replay) {
    if (replay.requestHash !== requestHash) throw idempotencyConflict();
    return replayResponse<CommitUsageResponse>(replay.responseSnapshot);
  }
  if (reservation.state === 'committed' || reservation.state === 'released') {
    throw stateConflict(reservation.state);
  }

  const actualUsd = await priceActualUsageFromFrozenPricing(
    transaction,
    {
      costSourceSlug: reservation.costSourceSlug,
      kind: reservation.kind,
      metric: reservation.metric,
      model: reservation.model,
      pricingSnapshot: reservation.pricingSnapshot,
      provider: reservation.provider,
    },
    reservation.pricingSnapshotHash,
    parsedRequest,
  );
  await assertRuntimeAmountCapacity(transaction, actualUsd);
  const settlement = calculateBudgetSettlement(reservation.reservedUsd, actualUsd);
  const allocationCount = await lockAllocationAccounts(
    transaction,
    builderId,
    reservation.decisionId,
  );
  reservation = await expireIfDue(transaction, builderId, reservation, allocationCount, randomUUID);

  let fromState = reservation.state;
  let fromVersion = reservation.stateVersion;
  let parentRows = await transaction<CommitParentResult[]>`
    UPDATE public.budget_reservations
    SET state = 'committed',
        actual_usd = ${settlement.actualUsd}::NUMERIC,
        released_usd = ${settlement.releasedUsd}::NUMERIC,
        overage_usd = ${settlement.overageUsd}::NUMERIC,
        unresolved_at = NULL,
        unresolved_reason = NULL,
        state_version = state_version + 1
    WHERE builder_id = ${builderId}::UUID
      AND decision_id = ${reservation.decisionId}::UUID
      AND state = ${fromState}
      AND (${fromState}::TEXT <> 'reserved' OR pg_catalog.clock_timestamp() < expires_at)
    RETURNING public.pylva_budget_timestamp_text(committed_at) AS "committedAt"
  `;
  if (parentRows.length === 0 && fromState === 'reserved') {
    // The lease can cross its boundary after the first expiry check. Recheck
    // under the same row/account locks so a terminal write can never skip the
    // mandatory reserved -> unresolved edge.
    reservation = await expireIfDue(
      transaction,
      builderId,
      reservation,
      allocationCount,
      randomUUID,
    );
    if (reservation.state !== 'unresolved') {
      throw integrityFailure('Commit lost the authoritative lease boundary');
    }
    fromState = reservation.state;
    fromVersion = reservation.stateVersion;
    parentRows = await transaction<CommitParentResult[]>`
      UPDATE public.budget_reservations
      SET state = 'committed',
          actual_usd = ${settlement.actualUsd}::NUMERIC,
          released_usd = ${settlement.releasedUsd}::NUMERIC,
          overage_usd = ${settlement.overageUsd}::NUMERIC,
          unresolved_at = NULL,
          unresolved_reason = NULL,
          state_version = state_version + 1
      WHERE builder_id = ${builderId}::UUID
        AND decision_id = ${reservation.decisionId}::UUID
        AND state = 'unresolved'
      RETURNING public.pylva_budget_timestamp_text(committed_at) AS "committedAt"
    `;
  }
  const committedAt = parentRows[0]?.committedAt;
  if (!committedAt) throw stateConflict(fromState);
  if (
    fromState === 'reserved' &&
    terminalTimestampAtOrAfterExpiry(committedAt, reservation.expiresAt)
  ) {
    // Roll the transaction back and retry from a fresh snapshot. The retry
    // will take the expiry edge first; publishing a terminal edge stamped at
    // or after its lease boundary is forbidden by the ledger.
    throw new BudgetLifecycleLeaseBoundaryRetryError();
  }

  const allocationRows = await transaction<{ id: string }[]>`
    UPDATE public.budget_reservation_allocations
    SET status = 'committed',
        actual_usd = ${settlement.actualUsd}::NUMERIC,
        released_usd = GREATEST(authorized_usd - ${settlement.actualUsd}::NUMERIC, 0),
        unresolved_usd = 0,
        overage_usd = GREATEST(${settlement.actualUsd}::NUMERIC - authorized_usd, 0)
    WHERE builder_id = ${builderId}::UUID
      AND reservation_decision_id = ${reservation.decisionId}::UUID
      AND status = ${fromState}
    RETURNING id
  `;
  if (allocationRows.length !== allocationCount) {
    throw integrityFailure('Commit did not transition every held allocation');
  }

  const budgetRows = await transaction<{ exceeded: boolean }[]>`
    SELECT COALESCE(BOOL_OR(
      allocation.enforcement = 'hard_stop'
      AND account.committed_usd + account.reserved_usd + account.unresolved_usd
        > allocation.limit_usd
    ), FALSE) AS exceeded
    FROM public.budget_reservation_allocations allocation
    JOIN public.budget_accounts account
      ON account.builder_id = allocation.builder_id
     AND account.id = allocation.account_id
    WHERE allocation.builder_id = ${builderId}::UUID
      AND allocation.reservation_decision_id = ${reservation.decisionId}::UUID
  `;
  const budgetExceededAfterCommit = budgetRows[0]?.exceeded ?? false;

  const retention = retentionForTier(reservation.billingTier);
  const usageId = randomUUID();
  const costEventId = randomUUID();
  const metadata = reservation.kind === 'llm' ? { token_count_source: 'exact' } : {};
  const usageRows = await transaction<{ id: string }[]>`
    INSERT INTO public.budget_usage_ledger (
      builder_id, id, reservation_decision_id, operation_id, cost_event_id,
      customer_id, trace_id, span_id, parent_span_id, step_name, framework,
      sdk_version, sdk_language, kind, provider, model,
      actual_input_tokens, actual_output_tokens,
      cost_source_slug, tool_name, metric, actual_value,
      status, latency_ms, stream_aborted, actual_cost_usd,
      pricing_snapshot, pricing_snapshot_hash, usage_snapshot, usage_snapshot_hash,
      cost_source, instrumentation_tier, is_demo,
      retention_days, billing_retention_days, metadata,
      committed_at, retain_until
    )
    VALUES (
      ${builderId}::UUID, ${usageId}::UUID, ${reservation.decisionId}::UUID,
      ${reservation.operationId}::UUID, ${costEventId}::UUID,
      ${reservation.customerId}, ${reservation.traceId}::UUID, ${reservation.spanId}::UUID,
      ${reservation.parentSpanId}::UUID, ${reservation.stepName}, ${reservation.framework},
      ${sdkIdentity.sdkVersion}, ${sdkIdentity.sdkLanguage}, ${reservation.kind},
      ${reservation.provider}, ${reservation.model},
      ${parsedRequest.kind === 'llm' ? parsedRequest.actual_input_tokens : null},
      ${parsedRequest.kind === 'llm' ? parsedRequest.actual_output_tokens : null},
      ${reservation.costSourceSlug}, ${reservation.toolName}, ${reservation.metric},
      ${parsedRequest.kind === 'tool' ? parsedRequest.actual_value : null}::NUMERIC,
      ${parsedRequest.status}, ${parsedRequest.latency_ms}, ${parsedRequest.stream_aborted},
      ${settlement.actualUsd}::NUMERIC,
      ${pgJsonbParameterText(jsonValue(reservation.pricingSnapshot))}::TEXT::JSONB,
      ${reservation.pricingSnapshotHash},
      ${pgJsonbParameterText(jsonValue(requestSnapshot))}::TEXT::JSONB, ${requestHash},
      ${reservation.kind === 'llm' ? 'auto' : 'configured'},
      ${reservation.kind === 'llm' ? 'sdk_wrapper' : 'reported'}, FALSE,
      ${retention.telemetry}, ${retention.billing},
      ${pgJsonbParameterText(jsonValue(metadata))}::TEXT::JSONB,
      ${committedAt}::TIMESTAMPTZ,
      ${committedAt}::TIMESTAMPTZ + ${retention.billing} * INTERVAL '1 day'
    )
    RETURNING id
  `;
  if (usageRows.length !== 1) throw integrityFailure('Commit did not create authoritative usage');

  const response: CommitUsageResponse = {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    state: 'committed',
    reservation_id: reservation.reservationId,
    operation_id: reservation.operationId,
    reserved_usd: settlement.reservedUsd,
    actual_usd: settlement.actualUsd,
    released_usd: settlement.releasedUsd,
    overage_usd: settlement.overageUsd,
    budget_exceeded_after_commit: budgetExceededAfterCommit,
    committed_at: committedAt,
    idempotent_replay: false,
    late: fromState === 'unresolved',
  };
  await transaction`
    INSERT INTO public.budget_reservation_transitions (
      builder_id, id, reservation_decision_id, type, extension_id, release_reason,
      request_hash, request_snapshot, response_snapshot,
      from_state, to_state, from_state_version, to_state_version,
      from_expires_at, to_expires_at, extend_by_seconds
    )
    VALUES (
      ${builderId}::UUID, ${randomUUID()}::UUID, ${reservation.decisionId}::UUID,
      'commit', NULL, NULL, ${requestHash},
      ${pgJsonbParameterText(jsonValue(requestSnapshot))}::TEXT::JSONB,
      ${pgJsonbParameterText(jsonValue(response))}::TEXT::JSONB,
      ${fromState}, 'committed', ${fromVersion.toString()}, ${(fromVersion + 1n).toString()},
      ${reservation.expiresAt}, ${reservation.expiresAt}, NULL
    )
  `;

  const outboxId = randomUUID();
  const outboxRows = await transaction<{ id: string }[]>`
    INSERT INTO public.budget_cost_event_outbox (
      builder_id, id, usage_ledger_id, cost_event_id,
      payload_schema_version, payload, payload_hash
    )
    SELECT usage.builder_id, ${outboxId}::UUID, usage.id, usage.cost_event_id,
           '1.6', projected.payload,
           public.pylva_budget_jsonb_sha256(projected.payload)
    FROM public.budget_usage_ledger usage
    CROSS JOIN LATERAL (
      SELECT public.pylva_budget_cost_event_payload(usage) AS payload
    ) projected
    WHERE usage.builder_id = ${builderId}::UUID
      AND usage.id = ${usageId}::UUID
      AND usage.cost_event_id = ${costEventId}::UUID
    RETURNING id
  `;
  if (outboxRows.length !== 1) throw integrityFailure('Commit did not create transactional outbox');
  return response;
}

async function releaseWithinTransaction(
  transaction: TransactionSql,
  builderId: string,
  reservationId: string,
  parsedRequest: ReleaseUsageRequest,
  randomUUID: () => string,
): Promise<ReleaseUsageResponse> {
  let reservation = await lockReservation(transaction, builderId, reservationId);
  if (!reservation) throw notFound();
  if (
    parsedRequest.reason !== BudgetReleaseReason.PROVIDER_NOT_CALLED &&
    parsedRequest.reason !== BudgetReleaseReason.PROVIDER_CONFIRMED_UNCHARGED
  ) {
    throw integrityFailure('Release requires authoritative proof that the provider was uncharged');
  }
  const requestSnapshot = parsedRequest as unknown as JsonObject;
  const requestHash = await pgCanonicalJsonbSha256(transaction, jsonValue(requestSnapshot));
  const replay = await existingTransition(
    transaction,
    builderId,
    reservation.decisionId,
    'release',
    null,
  );
  if (replay) {
    if (replay.requestHash !== requestHash) throw idempotencyConflict();
    return replayResponse<ReleaseUsageResponse>(replay.responseSnapshot);
  }
  if (reservation.state === 'committed' || reservation.state === 'released') {
    throw stateConflict(reservation.state);
  }

  const allocationCount = await lockAllocationAccounts(
    transaction,
    builderId,
    reservation.decisionId,
  );
  reservation = await expireIfDue(transaction, builderId, reservation, allocationCount, randomUUID);
  let fromState = reservation.state;
  let fromVersion = reservation.stateVersion;
  const releasedUsd = decimalText(decimalUnits(reservation.reservedUsd, 'reserved_usd'));
  let parentRows = await transaction<ReleaseParentResult[]>`
    UPDATE public.budget_reservations
    SET state = 'released',
        actual_usd = 0,
        released_usd = reserved_usd,
        overage_usd = 0,
        unresolved_at = NULL,
        unresolved_reason = NULL,
        state_version = state_version + 1
    WHERE builder_id = ${builderId}::UUID
      AND decision_id = ${reservation.decisionId}::UUID
      AND state = ${fromState}
      AND (${fromState}::TEXT <> 'reserved' OR pg_catalog.clock_timestamp() < expires_at)
    RETURNING public.pylva_budget_timestamp_text(released_at) AS "releasedAt"
  `;
  if (parentRows.length === 0 && fromState === 'reserved') {
    reservation = await expireIfDue(
      transaction,
      builderId,
      reservation,
      allocationCount,
      randomUUID,
    );
    if (reservation.state !== 'unresolved') {
      throw integrityFailure('Release lost the authoritative lease boundary');
    }
    fromState = reservation.state;
    fromVersion = reservation.stateVersion;
    parentRows = await transaction<ReleaseParentResult[]>`
      UPDATE public.budget_reservations
      SET state = 'released',
          actual_usd = 0,
          released_usd = reserved_usd,
          overage_usd = 0,
          unresolved_at = NULL,
          unresolved_reason = NULL,
          state_version = state_version + 1
      WHERE builder_id = ${builderId}::UUID
        AND decision_id = ${reservation.decisionId}::UUID
        AND state = 'unresolved'
      RETURNING public.pylva_budget_timestamp_text(released_at) AS "releasedAt"
    `;
  }
  const releasedAt = parentRows[0]?.releasedAt;
  if (!releasedAt) throw stateConflict(fromState);
  if (
    fromState === 'reserved' &&
    terminalTimestampAtOrAfterExpiry(releasedAt, reservation.expiresAt)
  ) {
    throw new BudgetLifecycleLeaseBoundaryRetryError();
  }

  const allocationRows = await transaction<{ id: string }[]>`
    UPDATE public.budget_reservation_allocations
    SET status = 'released',
        actual_usd = 0,
        released_usd = authorized_usd,
        unresolved_usd = 0,
        overage_usd = 0
    WHERE builder_id = ${builderId}::UUID
      AND reservation_decision_id = ${reservation.decisionId}::UUID
      AND status = ${fromState}
    RETURNING id
  `;
  if (allocationRows.length !== allocationCount) {
    throw integrityFailure('Release did not transition every held allocation');
  }

  const response: ReleaseUsageResponse = {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    state: 'released',
    reservation_id: reservation.reservationId,
    operation_id: reservation.operationId,
    released_usd: releasedUsd,
    released_at: releasedAt,
    idempotent_replay: false,
  };
  await transaction`
    INSERT INTO public.budget_reservation_transitions (
      builder_id, id, reservation_decision_id, type, extension_id, release_reason,
      request_hash, request_snapshot, response_snapshot,
      from_state, to_state, from_state_version, to_state_version,
      from_expires_at, to_expires_at, extend_by_seconds
    )
    VALUES (
      ${builderId}::UUID, ${randomUUID()}::UUID, ${reservation.decisionId}::UUID,
      'release', NULL, ${parsedRequest.reason}, ${requestHash},
      ${pgJsonbParameterText(jsonValue(requestSnapshot))}::TEXT::JSONB,
      ${pgJsonbParameterText(jsonValue(response))}::TEXT::JSONB,
      ${fromState}, 'released', ${fromVersion.toString()}, ${(fromVersion + 1n).toString()},
      ${reservation.expiresAt}, ${reservation.expiresAt}, NULL
    )
  `;
  return response;
}

async function extendWithinTransaction(
  transaction: TransactionSql,
  builderId: string,
  reservationId: string,
  parsedRequest: ExtendUsageRequest,
  randomUUID: () => string,
): Promise<ExtendUsageResponse> {
  const reservation = await lockReservation(transaction, builderId, reservationId);
  if (!reservation) throw notFound();
  const requestSnapshot = parsedRequest as unknown as JsonObject;
  const requestHash = await pgCanonicalJsonbSha256(transaction, jsonValue(requestSnapshot));
  const replay = await existingTransition(
    transaction,
    builderId,
    reservation.decisionId,
    'extend',
    parsedRequest.extension_id,
  );
  if (replay) {
    if (replay.requestHash !== requestHash) throw idempotencyConflict();
    return replayResponse<ExtendUsageResponse>(replay.responseSnapshot);
  }
  if (reservation.state !== 'reserved') throw stateConflict(reservation.state);

  const parentRows = await transaction<ExtendParentResult[]>`
    UPDATE public.budget_reservations
    SET expires_at = expires_at
          + pg_catalog.make_interval(secs => ${parsedRequest.extend_by_seconds}),
        state_version = state_version + 1
    WHERE builder_id = ${builderId}::UUID
      AND decision_id = ${reservation.decisionId}::UUID
      AND state = 'reserved'
      AND pg_catalog.clock_timestamp() < expires_at
    RETURNING public.pylva_budget_timestamp_text(expires_at) AS "expiresAt",
              public.pylva_budget_timestamp_text(updated_at) AS "extendedAt"
  `;
  const expiresAt = parentRows[0]?.expiresAt;
  const extendedAt = parentRows[0]?.extendedAt;
  if (!expiresAt) throw stateConflict('expired');
  if (!extendedAt) throw integrityFailure('Extension has no authoritative timestamp');
  if (terminalTimestampAtOrAfterExpiry(extendedAt, reservation.expiresAt)) {
    throw new BudgetLifecycleLeaseBoundaryRetryError();
  }

  const response: ExtendUsageResponse = {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    state: 'reserved',
    reservation_id: reservation.reservationId,
    operation_id: reservation.operationId,
    extension_id: parsedRequest.extension_id,
    expires_at: expiresAt,
    idempotent_replay: false,
  };
  await transaction`
    INSERT INTO public.budget_reservation_transitions (
      builder_id, id, reservation_decision_id, type, extension_id, release_reason,
      request_hash, request_snapshot, response_snapshot,
      from_state, to_state, from_state_version, to_state_version,
      from_expires_at, to_expires_at, extend_by_seconds
    )
    VALUES (
      ${builderId}::UUID, ${randomUUID()}::UUID, ${reservation.decisionId}::UUID,
      'extend', ${parsedRequest.extension_id}::UUID, NULL, ${requestHash},
      ${pgJsonbParameterText(jsonValue(requestSnapshot))}::TEXT::JSONB,
      ${pgJsonbParameterText(jsonValue(response))}::TEXT::JSONB,
      'reserved', 'reserved', ${reservation.stateVersion.toString()},
      ${(reservation.stateVersion + 1n).toString()},
      ${reservation.expiresAt}, ${expiresAt}::TIMESTAMPTZ,
      ${parsedRequest.extend_by_seconds}
    )
  `;
  return response;
}

async function lockOneExpiredReservation(
  transaction: TransactionSql,
  builderId: string,
): Promise<LockedReservation | null> {
  const rows = await transaction<{ reservation_id: string }[]>`
    SELECT reservation_id
    FROM public.budget_reservations
    WHERE builder_id = ${builderId}::UUID
      AND decision = 'reserved'
      AND state = 'reserved'
      AND expires_at <= pg_catalog.clock_timestamp()
    ORDER BY expires_at ASC, decision_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `;
  const reservationId = rows[0]?.reservation_id;
  return reservationId ? lockReservation(transaction, builderId, reservationId) : null;
}

function validateExpiryLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EXPIRY_BATCH_LIMIT) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_EXPIRY_BATCH_LIMIT}`);
  }
  return limit;
}

export function createBudgetLifecycleService(
  dependencies: BudgetLifecycleServiceDependencies = {},
): BudgetLifecycleService {
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const transactOnce = <T>(
    builderId: string,
    callback: (transaction: TransactionSql) => Promise<T>,
  ): Promise<T> =>
    withBudgetControlTransaction(
      builderId,
      async (transaction) => {
        // Billing closure takes the exclusive form of this builder lock. Every
        // lifecycle transaction must take the shared form before it can stamp
        // or publish authoritative usage so the gate cannot miss an already
        // open commit. Shared lifecycle operations remain mutually concurrent.
        await acquireBudgetBuilderSharedLock(transaction, builderId);
        return callback(transaction);
      },
      dependencies.transactionOptions,
    );
  const transact = async <T>(
    builderId: string,
    callback: (transaction: TransactionSql) => Promise<T>,
  ): Promise<T> => {
    try {
      return await transactOnce(builderId, callback);
    } catch (error) {
      if (
        !(error instanceof BudgetLifecycleLeaseBoundaryRetryError) &&
        !isExtensionLeaseBoundaryDatabaseError(error)
      ) {
        throw error;
      }
      // The first transaction was rolled back. Server time is now at or past
      // the same immutable expiry, so one fresh transaction deterministically
      // records expiry before the requested late commit/release.
      return transactOnce(builderId, callback);
    }
  };

  return {
    commitBudgetUsage: (builderId, reservationId, parsedRequest, sdkIdentity) =>
      transact(builderId, (transaction) =>
        commitWithinTransaction(
          transaction,
          builderId,
          reservationId,
          parsedRequest,
          sdkIdentity,
          randomUUID,
        ),
      ),
    releaseBudgetUsage: (builderId, reservationId, parsedRequest, _sdkIdentity) =>
      transact(builderId, (transaction) =>
        releaseWithinTransaction(transaction, builderId, reservationId, parsedRequest, randomUUID),
      ),
    extendBudgetUsage: (builderId, reservationId, parsedRequest, _sdkIdentity) =>
      transact(builderId, (transaction) =>
        extendWithinTransaction(transaction, builderId, reservationId, parsedRequest, randomUUID),
      ),
    expireDueBudgetReservations: async (
      builderId,
      limit = DEFAULT_EXPIRY_BATCH_LIMIT,
    ): Promise<ExpireDueBudgetReservationsResult> => {
      const boundedLimit = validateExpiryLimit(limit);
      let expired = 0;
      // One reservation per transaction prevents cross-batch account-lock
      // inversions while SKIP LOCKED lets multiple workers make progress.
      for (let index = 0; index < boundedLimit; index += 1) {
        const didExpire = await transact(builderId, async (transaction) => {
          const reservation = await lockOneExpiredReservation(transaction, builderId);
          if (!reservation) return false;
          const allocationCount = await lockAllocationAccounts(
            transaction,
            builderId,
            reservation.decisionId,
          );
          const result = await expireIfDue(
            transaction,
            builderId,
            reservation,
            allocationCount,
            randomUUID,
          );
          return result.state === 'unresolved';
        });
        if (!didExpire) break;
        expired += 1;
      }
      return { expired };
    },
  };
}

const defaultService = createBudgetLifecycleService();

export const commitBudgetUsage = defaultService.commitBudgetUsage;
export const releaseBudgetUsage = defaultService.releaseBudgetUsage;
export const extendBudgetUsage = defaultService.extendBudgetUsage;
export const expireDueBudgetReservations = defaultService.expireDueBudgetReservations;

export const __budgetLifecycleTesting = {
  assertRuntimeAmountCapacity,
  decimalText,
  decimalUnits,
  lockAllocationAccounts,
  isExtensionLeaseBoundaryDatabaseError,
  replayResponse,
  terminalTimestampAtOrAfterExpiry,
  validateExpiryLimit,
  runtimeLimits: {
    numeric38Units: NUMERIC_38_18_UNITS_LIMIT,
    numeric44Units: NUMERIC_44_18_UNITS_LIMIT,
  },
};
