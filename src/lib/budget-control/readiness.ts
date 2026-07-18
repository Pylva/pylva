import type { Sql, TransactionSql } from 'postgres';
import {
  getBudgetExactBackfillAdapter,
  type BudgetExactBackfillAdapter,
} from './exact-backfill-adapter.js';
import {
  pgCanonicalJsonbSha256,
  pgJsonbParameterText,
  withBudgetBuilderTransaction,
  type BudgetTransactionOptions,
} from './transaction.js';

export type BudgetControlCutoverMode = 'next_period' | 'exact_backfill';

export type BudgetControlReadiness =
  | {
      ready: false;
      reason: 'missing';
      mode: null;
      cutover_at: null;
    }
  | {
      ready: false;
      reason: 'pending';
      mode: BudgetControlCutoverMode;
      cutover_at: string;
    }
  | {
      ready: true;
      mode: BudgetControlCutoverMode;
      cutover_at: string;
      ready_order: string;
      ready_at: string;
    };

export type BudgetControlNotReadyReadiness = Extract<BudgetControlReadiness, { ready: false }>;

export interface BudgetControlReadinessOptions extends Pick<
  BudgetTransactionOptions,
  'maxAttempts' | 'sleep' | 'onRetry'
> {
  client?: Sql;
}

export interface ExactBackfillActivationInput {
  transaction: TransactionSql;
  builderId: string;
  cutoverAt: string;
}

/**
 * Establishes the durable legacy-traffic fence and reconciliation watermark.
 * Per-account exact balances are supplied later by the in-transaction account
 * materializer resolver. This callback runs inside the exclusive builder
 * transaction, may be retried, and must not perform external side effects.
 */
export type ActivateExactBudgetBackfill = (
  input: ExactBackfillActivationInput,
) => void | Promise<void>;

export interface MarkBudgetControlReadyOptions extends BudgetControlReadinessOptions {
  activateExactBackfill?: ActivateExactBudgetBackfill;
  exactBackfillAdapter?: BudgetExactBackfillAdapter;
}

interface ReadinessRow {
  status: unknown;
  mode: unknown;
  cutover_at: unknown;
  reconciled_through: unknown;
  has_reconciliation_snapshot: unknown;
  reconciliation_snapshot_hash: unknown;
  ready_order: unknown;
  ready_at: unknown;
}

const CUTOVER_MODES = new Set<BudgetControlCutoverMode>(['next_period', 'exact_backfill']);
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSITIVE_BIGINT_PATTERN = /^[1-9][0-9]*$/;
const MAX_AUTHORITY_ORDER = 9_223_372_036_854_775_806n;

export class BudgetControlCutoverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetControlCutoverConflictError';
  }
}

export class BudgetControlNotReadyError extends Error {
  readonly readiness: BudgetControlNotReadyReadiness;

  constructor(readiness: BudgetControlNotReadyReadiness) {
    super(
      readiness.reason === 'missing'
        ? 'builder has no authoritative budget-control cutover'
        : 'builder authoritative budget-control cutover is still pending',
    );
    this.name = 'BudgetControlNotReadyError';
    this.readiness = readiness;
  }
}

export class BudgetExactBackfillActivationUnavailableError extends Error {
  constructor() {
    super('exact-backfill activation requires an explicit reconciled traffic-fence adapter');
    this.name = 'BudgetExactBackfillActivationUnavailableError';
  }
}

function isCutoverMode(value: unknown): value is BudgetControlCutoverMode {
  return typeof value === 'string' && CUTOVER_MODES.has(value as BudgetControlCutoverMode);
}

function assertBuilderId(builderId: string): void {
  if (!UUID_PATTERN.test(builderId)) throw new TypeError('builderId must be a UUID');
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_TIMESTAMP_PATTERN.test(value);
}

function parseReadinessRows(rows: readonly ReadinessRow[]): BudgetControlReadiness {
  if (rows.length === 0) {
    return { ready: false, reason: 'missing', mode: null, cutover_at: null };
  }
  if (rows.length !== 1) {
    throw new Error('budget-control readiness query returned more than one builder row');
  }

  const row = rows[0]!;
  if (!isCutoverMode(row.mode) || !isCanonicalTimestamp(row.cutover_at)) {
    throw new Error('budget-control readiness row has an invalid mode or cutover timestamp');
  }
  if (
    row.status === 'pending' &&
    row.ready_at === null &&
    row.reconciled_through === null &&
    row.has_reconciliation_snapshot === false &&
    row.reconciliation_snapshot_hash === null &&
    row.ready_order === null
  ) {
    return {
      ready: false,
      reason: 'pending',
      mode: row.mode,
      cutover_at: row.cutover_at,
    };
  }
  if (
    row.status === 'ready' &&
    isCanonicalTimestamp(row.ready_at) &&
    row.ready_at >= row.cutover_at &&
    typeof row.ready_order === 'string' &&
    POSITIVE_BIGINT_PATTERN.test(row.ready_order) &&
    BigInt(row.ready_order) <= MAX_AUTHORITY_ORDER &&
    ((row.mode === 'next_period' &&
      row.reconciled_through === null &&
      row.has_reconciliation_snapshot === false &&
      row.reconciliation_snapshot_hash === null) ||
      (row.mode === 'exact_backfill' &&
        row.reconciled_through === row.cutover_at &&
        row.has_reconciliation_snapshot === true &&
        typeof row.reconciliation_snapshot_hash === 'string' &&
        SHA256_PATTERN.test(row.reconciliation_snapshot_hash)))
  ) {
    return {
      ready: true,
      mode: row.mode,
      cutover_at: row.cutover_at,
      ready_order: row.ready_order,
      ready_at: row.ready_at,
    };
  }
  throw new Error('budget-control readiness row has an invalid lifecycle state');
}

/**
 * Reads the typed PostgreSQL readiness authority inside an existing
 * tenant-scoped transaction. Callers that use the result for authorization or
 * account creation must already hold the builder lock appropriate to that
 * operation.
 */
export async function readBudgetControlReadinessInTransaction(
  transaction: TransactionSql,
  builderId: string,
): Promise<BudgetControlReadiness> {
  assertBuilderId(builderId);
  const rows = await transaction<ReadinessRow[]>`
    SELECT status, mode,
           public.pylva_budget_timestamp_text(cutover_at) AS cutover_at,
           CASE WHEN reconciled_through IS NULL THEN NULL
             ELSE public.pylva_budget_timestamp_text(reconciled_through)
           END AS reconciled_through,
           (reconciliation_snapshot IS NOT NULL) AS has_reconciliation_snapshot,
           reconciliation_snapshot_hash,
           ready_order::TEXT AS ready_order,
           CASE WHEN ready_at IS NULL THEN NULL
             ELSE public.pylva_budget_timestamp_text(ready_at)
           END AS ready_at
    FROM public.budget_control_cutovers
    WHERE builder_id = ${builderId}::UUID
  `;
  return parseReadinessRows(rows);
}

/** A fail-closed capability read, linearized with rule/account configuration. */
export function getBudgetControlReadiness(
  builderId: string,
  options: BudgetControlReadinessOptions = {},
): Promise<BudgetControlReadiness> {
  assertBuilderId(builderId);
  return withBudgetBuilderTransaction(
    builderId,
    'shared',
    (transaction) => readBudgetControlReadinessInTransaction(transaction, builderId),
    options,
  );
}

/**
 * Creates the one-way pending cutover record. Repeating the same mode is
 * idempotent; attempting to replace its immutable mode is an explicit conflict.
 */
export function createBudgetControlCutover(
  builderId: string,
  mode: BudgetControlCutoverMode,
  options: BudgetControlReadinessOptions = {},
): Promise<BudgetControlReadiness> {
  assertBuilderId(builderId);
  if (!isCutoverMode(mode)) throw new TypeError(`unsupported budget-control cutover mode: ${mode}`);

  return withBudgetBuilderTransaction(
    builderId,
    'exclusive',
    async (transaction) => {
      await transaction`
        INSERT INTO public.budget_control_cutovers (builder_id, mode)
        VALUES (${builderId}::UUID, ${mode})
        ON CONFLICT (builder_id) DO NOTHING
      `;
      const readiness = await readBudgetControlReadinessInTransaction(transaction, builderId);
      if (readiness.mode !== mode) {
        throw new BudgetControlCutoverConflictError(
          'builder already has a budget-control cutover with a different immutable mode',
        );
      }
      return readiness;
    },
    options,
  );
}

/** Re-evaluates a pending next-period boundary under the exclusive lock. */
export function refreshBudgetControlCutover(
  builderId: string,
  options: BudgetControlReadinessOptions = {},
): Promise<BudgetControlReadiness> {
  assertBuilderId(builderId);
  return withBudgetBuilderTransaction(
    builderId,
    'exclusive',
    async (transaction) => {
      await transaction`
        UPDATE public.budget_control_cutovers
        SET cutover_at = cutover_at
        WHERE builder_id = ${builderId}::UUID AND status = 'pending'
      `;
      return readBudgetControlReadinessInTransaction(transaction, builderId);
    },
    options,
  );
}

/**
 * Performs the database-owned one-way pending -> ready transition. Exact
 * backfill readiness evidence is constructed canonically from the immutable
 * watermark; callers cannot supply a competing timestamp or arbitrary JSON
 * snapshot.
 */
export function markBudgetControlReady(
  builderId: string,
  options: MarkBudgetControlReadyOptions = {},
): Promise<BudgetControlReadiness> {
  assertBuilderId(builderId);
  return withBudgetBuilderTransaction(
    builderId,
    'exclusive',
    async (transaction) => {
      const current = await readBudgetControlReadinessInTransaction(transaction, builderId);
      if (current.ready) return current;
      if (current.reason === 'missing') throw new BudgetControlNotReadyError(current);

      if (current.mode === 'next_period') {
        await transaction`
          UPDATE public.budget_control_cutovers
          SET status = 'ready'
          WHERE builder_id = ${builderId}::UUID AND status = 'pending'
        `;
      } else {
        const adapter = options.exactBackfillAdapter ?? getBudgetExactBackfillAdapter();
        const activateExactBackfill =
          options.activateExactBackfill ??
          (adapter ? (input: ExactBackfillActivationInput) => adapter.activate(input) : undefined);
        if (!activateExactBackfill) {
          throw new BudgetExactBackfillActivationUnavailableError();
        }
        await activateExactBackfill({
          transaction,
          builderId,
          cutoverAt: current.cutover_at,
        });
        const snapshot = {
          schema_version: '1.0',
          builder_id: builderId.toLowerCase(),
          mode: 'exact_backfill',
          cutover_at: current.cutover_at,
          reconciled_through: current.cutover_at,
        } as const;
        const snapshotHash = await pgCanonicalJsonbSha256(transaction, snapshot);
        await transaction`
          UPDATE public.budget_control_cutovers
          SET status = 'ready',
              reconciled_through = cutover_at,
              reconciliation_snapshot = ${pgJsonbParameterText(snapshot)}::TEXT::JSONB,
              reconciliation_snapshot_hash = ${snapshotHash}
          WHERE builder_id = ${builderId}::UUID AND status = 'pending'
        `;
      }

      const ready = await readBudgetControlReadinessInTransaction(transaction, builderId);
      if (!ready.ready) {
        throw new BudgetControlCutoverConflictError(
          'budget-control cutover did not become ready in the locked transaction',
        );
      }
      return ready;
    },
    options,
  );
}
