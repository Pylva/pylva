import type postgres from 'postgres';
import type { Sql, TransactionSql } from 'postgres';
import { pgErrorCode } from '../db/pg-error.js';

/**
 * Must remain identical to the seed used by migration 050's builder locks.
 * This integer is below Number.MAX_SAFE_INTEGER, so binding it as a JS number
 * and casting it to BIGINT in PostgreSQL is exact.
 */
export const BUDGET_BUILDER_LOCK_SEED = 50_620_260_714;

/** Domain-separates per-operation hash keys from builder hash keys. */
export const BUDGET_OPERATION_LOCK_SEED = 50_620_260_715;

export const DEFAULT_BUDGET_TRANSACTION_MAX_ATTEMPTS = 3;
export const MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS = 5;

/**
 * Delay after failed attempts one through four. There is intentionally no
 * jitter: retry behavior must be bounded and deterministic in this control
 * path. The hard attempt cap prevents an invariant bug from spinning forever.
 */
export const BUDGET_TRANSACTION_RETRY_DELAYS_MS = Object.freeze([5, 20, 50, 100] as const);

export type BudgetBuilderLockMode = 'shared' | 'exclusive';

export type BudgetTransactionRetryReason =
  | 'serialization_failure'
  | 'deadlock_detected'
  | 'stale_allocation_closure'
  | 'authorization_lease_expired';

export type BudgetTransactionRetryClassification =
  | {
      retryable: true;
      reason: BudgetTransactionRetryReason;
      code: string;
    }
  | {
      retryable: false;
      reason: null;
      code: string | null;
    };

export interface BudgetTransactionContext {
  /** One-based attempt number for this invocation of the transaction body. */
  attempt: number;
  maxAttempts: number;
}

export interface BudgetTransactionRetryEvent {
  attempt: number;
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
  code: string;
  reason: BudgetTransactionRetryReason;
}

export interface BudgetTransactionOptions {
  /** Total attempts, including the first. Values above the hard cap fail fast. */
  maxAttempts?: number;
  /** Dependency injection for tests; production uses the attested dedicated client. */
  client?: Sql;
  /** Dependency injection for deterministic tests. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Hook for metrics/logging. It must not expose request or provider payloads. */
  onRetry?: (event: BudgetTransactionRetryEvent) => void | Promise<void>;
}

export type BudgetTransactionCallback<T> = (
  transaction: TransactionSql,
  context: BudgetTransactionContext,
) => T | Promise<T>;

const STALE_ALLOCATION_CLOSURE_MESSAGES = new Set([
  'reserved lifecycle requires matching allocation settlement',
  'denial requires exactly one matching deciding allocation',
  'shadow decision requires matching shadow allocations',
  'no_applicable_budget requires an empty applicable global rule revision set',
]);

const AUTHORIZATION_LEASE_EXPIRED_MESSAGE =
  'reservation lease expired before authorization could commit';

function ownStringProperty(value: unknown, property: 'code' | 'message'): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Object.prototype.hasOwnProperty.call(value, property)
  ) {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' ? candidate : null;
}

function errorCause(error: unknown): unknown {
  if (
    typeof error !== 'object' ||
    error === null ||
    !Object.prototype.hasOwnProperty.call(error, 'cause')
  ) {
    return undefined;
  }

  return (error as { cause?: unknown }).cause;
}

/**
 * Mirrors pgErrorCode's direct-then-cause precedence while keeping the message
 * on that same object. Never combine a wrapper's SQLSTATE with its cause's text.
 */
function selectedPgErrorMessage(error: unknown): string | null {
  if (ownStringProperty(error, 'code') !== null) {
    return ownStringProperty(error, 'message');
  }

  const cause = errorCause(error);
  if (ownStringProperty(cause, 'code') !== null) {
    return ownStringProperty(cause, 'message');
  }

  return null;
}

/**
 * Classifies only the failures that are safe to replay from a fresh transaction.
 * In particular, SQLSTATE 23514 and 57014 are never retried by code alone:
 * unrelated constraint violations and query cancellations must remain terminal.
 */
export function classifyBudgetTransactionError(
  error: unknown,
): BudgetTransactionRetryClassification {
  const code = pgErrorCode(error);
  const message = selectedPgErrorMessage(error);

  if (code === '40001') {
    return { retryable: true, reason: 'serialization_failure', code };
  }
  if (code === '40P01') {
    return { retryable: true, reason: 'deadlock_detected', code };
  }
  if (code === '23514' && message !== null && STALE_ALLOCATION_CLOSURE_MESSAGES.has(message)) {
    return { retryable: true, reason: 'stale_allocation_closure', code };
  }
  if (code === '57014' && message === AUTHORIZATION_LEASE_EXPIRED_MESSAGE) {
    return { retryable: true, reason: 'authorization_lease_expired', code };
  }

  return { retryable: false, reason: null, code };
}

export function budgetTransactionRetryDelayMs(failedAttempt: number): number {
  if (
    !Number.isSafeInteger(failedAttempt) ||
    failedAttempt < 1 ||
    failedAttempt >= MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS
  ) {
    throw new RangeError(
      `failedAttempt must be an integer between 1 and ${MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS - 1}`,
    );
  }

  return BUDGET_TRANSACTION_RETRY_DELAYS_MS[failedAttempt - 1]!;
}

function validateMaxAttempts(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS) {
    throw new RangeError(
      `maxAttempts must be an integer between 1 and ${MAX_BUDGET_TRANSACTION_MAX_ATTEMPTS}`,
    );
  }

  return value;
}

function assertNonBlankIdentifier(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank`);
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function defaultBudgetControlSql(): Promise<Sql> {
  const { getReadyBudgetControlSql } = await import('./runtime-posture.js');
  return getReadyBudgetControlSql();
}

/**
 * Runs a tenant-scoped, explicit READ COMMITTED transaction on postgres.js.
 *
 * The callback may run more than once. It must keep all replayable mutations
 * inside this PostgreSQL transaction and must not perform provider dispatches
 * or other external side effects.
 */
export async function withBudgetControlTransaction<T>(
  builderId: string,
  callback: BudgetTransactionCallback<T>,
  options: BudgetTransactionOptions = {},
): Promise<T> {
  assertNonBlankIdentifier(builderId, 'builderId');
  const maxAttempts = validateMaxAttempts(
    options.maxAttempts ?? DEFAULT_BUDGET_TRANSACTION_MAX_ATTEMPTS,
  );
  const client = options.client ?? (await defaultBudgetControlSql());
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await client.begin('isolation level read committed', async (transaction) => {
        // set_config(..., true) is the parameter-safe equivalent of
        // SET LOCAL app.builder_id and is automatically cleared at transaction end.
        await transaction`
          SELECT pg_catalog.set_config(
            'app.builder_id', ${builderId}::UUID::TEXT, TRUE
          )
        `;
        return callback(transaction, { attempt, maxAttempts });
      });

      return result as T;
    } catch (error) {
      const classification = classifyBudgetTransactionError(error);
      if (!classification.retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = budgetTransactionRetryDelayMs(attempt);
      await options.onRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        code: classification.code,
        reason: classification.reason,
      });
      await sleep(delayMs);
    }
  }

  throw new Error('budget transaction exhausted an unreachable retry path');
}

/**
 * Acquires the same shared builder lock used by reservation capture in the
 * frozen ledger migration. UUID normalization ensures an exact matching key.
 */
export async function acquireBudgetBuilderSharedLock(
  transaction: TransactionSql,
  builderId: string,
): Promise<void> {
  assertNonBlankIdentifier(builderId, 'builderId');
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended(
        ${builderId}::UUID::TEXT,
        ${BUDGET_BUILDER_LOCK_SEED}::BIGINT
      )
    )
  `;
}

/** Acquires migration 050's exclusive builder configuration lock. */
export async function acquireBudgetBuilderExclusiveLock(
  transaction: TransactionSql,
  builderId: string,
): Promise<void> {
  assertNonBlankIdentifier(builderId, 'builderId');
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${builderId}::UUID::TEXT,
        ${BUDGET_BUILDER_LOCK_SEED}::BIGINT
      )
    )
  `;
}

export async function acquireBudgetBuilderLock(
  transaction: TransactionSql,
  builderId: string,
  mode: BudgetBuilderLockMode,
): Promise<void> {
  if (mode === 'shared') {
    await acquireBudgetBuilderSharedLock(transaction, builderId);
    return;
  }
  if (mode === 'exclusive') {
    await acquireBudgetBuilderExclusiveLock(transaction, builderId);
    return;
  }

  throw new TypeError(`unsupported budget builder lock mode: ${String(mode)}`);
}

/**
 * Runs a transaction whose builder lock is acquired before caller policy reads.
 * Reservation services should use `shared`; rule/account materialization uses
 * `exclusive` in its own narrow transaction.
 */
export function withBudgetBuilderTransaction<T>(
  builderId: string,
  mode: BudgetBuilderLockMode,
  callback: BudgetTransactionCallback<T>,
  options: BudgetTransactionOptions = {},
): Promise<T> {
  return withBudgetControlTransaction(
    builderId,
    async (transaction, context) => {
      await acquireBudgetBuilderLock(transaction, builderId, mode);
      return callback(transaction, context);
    },
    options,
  );
}

/**
 * Serializes one builder-scoped operation ID. The domain string and distinct
 * seed make operation hashes independent from builder configuration hashes.
 */
export async function acquireBudgetOperationLock(
  transaction: TransactionSql,
  builderId: string,
  operationId: string,
): Promise<void> {
  assertNonBlankIdentifier(builderId, 'builderId');
  assertNonBlankIdentifier(operationId, 'operationId');
  await transaction`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        pg_catalog.concat(
          'pylva-budget-operation:',
          ${builderId}::UUID::TEXT,
          ':',
          ${operationId}::UUID::TEXT
        ),
        ${BUDGET_OPERATION_LOCK_SEED}::BIGINT
      )
    )
  `;
}

type CanonicalTextRow = { value: string };

function requiredCanonicalText(rows: readonly CanonicalTextRow[], helperName: string): string {
  const value = rows[0]?.value;
  if (typeof value !== 'string') {
    throw new Error(`${helperName} returned no canonical text value`);
  }
  return value;
}

/**
 * Bind JSON through PostgreSQL's text input instead of postgres.js `sql.json`.
 *
 * Drizzle intentionally replaces the shared client's JSON/JSONB serializers
 * with identity functions. That is correct for Drizzle's pre-serialized
 * values, but raw postgres.js callers would otherwise pass an object to the
 * wire encoder and fail before PostgreSQL sees the query. A text parameter
 * followed by an explicit `::JSONB` cast preserves the same JSON semantics
 * without depending on mutable client serializer state.
 */
export function pgJsonbParameterText(value: postgres.JSONValue): string {
  const seen = new Set<object>();
  let nodeCount = 0;

  const visit = (candidate: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > 100_000 || depth > 64) {
      throw new TypeError('JSONB parameter exceeds the strict JSON complexity limit');
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new TypeError('JSONB parameter numbers must be finite');
      }
      return;
    }
    if (typeof candidate !== 'object') {
      throw new TypeError('JSONB parameter contains an unsupported JSON value');
    }
    if (seen.has(candidate)) throw new TypeError('JSONB parameter must not be cyclic');
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const names = Object.getOwnPropertyNames(candidate);
        if (
          names.length !== candidate.length + 1 ||
          names[names.length - 1] !== 'length' ||
          Object.getOwnPropertySymbols(candidate).length !== 0
        ) {
          throw new TypeError('JSONB parameter arrays must be dense JSON arrays');
        }
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new TypeError('JSONB parameter arrays must contain plain data values');
          }
          visit(descriptor.value, depth + 1);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('JSONB parameter objects must use a plain object prototype');
      }
      if (Object.getOwnPropertySymbols(candidate).length !== 0) {
        throw new TypeError('JSONB parameter objects must not contain symbol keys');
      }
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
        if (!descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('JSONB parameter objects must contain enumerable data values');
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      seen.delete(candidate);
    }
  };

  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new TypeError('JSONB parameter must serialize to JSON text');
  }
  return serialized;
}

/** SHA-256 of PostgreSQL's canonical JSONB text, never of caller JSON text. */
export async function pgCanonicalJsonbSha256(
  transaction: TransactionSql,
  value: postgres.JSONValue,
): Promise<string> {
  const rows = await transaction<CanonicalTextRow[]>`
    SELECT public.pylva_budget_jsonb_sha256(
      ${pgJsonbParameterText(value)}::TEXT::JSONB
    ) AS value
  `;
  return requiredCanonicalText(rows, 'pylva_budget_jsonb_sha256');
}

/** Exact canonical decimal text; callers pass a string to avoid IEEE-754 loss. */
export async function pgCanonicalDecimalText(
  transaction: TransactionSql,
  value: string,
): Promise<string> {
  const rows = await transaction<CanonicalTextRow[]>`
    SELECT public.pylva_budget_decimal_text(${value}::NUMERIC) AS value
  `;
  return requiredCanonicalText(rows, 'pylva_budget_decimal_text');
}

/** Canonical UTC, millisecond-precision wire text for a PostgreSQL timestamptz. */
export async function pgCanonicalTimestampText(
  transaction: TransactionSql,
  value: string | Date,
): Promise<string> {
  const rows = await transaction<CanonicalTextRow[]>`
    SELECT public.pylva_budget_timestamp_text(${value}::TIMESTAMPTZ) AS value
  `;
  return requiredCanonicalText(rows, 'pylva_budget_timestamp_text');
}

/** A single server clock sample rendered by the ledger's canonical time helper. */
export async function pgCanonicalNowText(transaction: TransactionSql): Promise<string> {
  const rows = await transaction<CanonicalTextRow[]>`
    WITH authoritative_time AS (
      SELECT pg_catalog.date_trunc(
        'milliseconds', pg_catalog.clock_timestamp()
      ) AS value
    )
    SELECT public.pylva_budget_timestamp_text(value) AS value
    FROM authoritative_time
  `;
  return requiredCanonicalText(rows, 'pylva_budget_timestamp_text(clock_timestamp())');
}
