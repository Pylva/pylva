import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import {
  createBudgetProjectionTarget,
  type BudgetProjectionInspection,
  type BudgetProjectionTarget,
} from './clickhouse.js';
import { parseAuthoritativeBudgetCostEventPayload } from './contracts.js';
import {
  assertBudgetProjectionWorkerId,
  createBudgetProjectionPostgresStore,
  createBudgetProjectionWorkerId,
  type BudgetProjectionFailure,
  type BudgetProjectionLease,
  type BudgetProjectionPostgresStore,
  type BudgetProjectionReconciliationItem,
} from './postgres.js';

const DEFAULT_BUILDER_PAGE_SIZE = 250;
const DEFAULT_BUILDER_CONCURRENCY = 5;
const DEFAULT_CLAIM_LIMIT = 50;
const DEFAULT_EVENT_CONCURRENCY = 5;
const DEFAULT_RECOVERY_LIMIT = 100;
const DEFAULT_RECONCILIATION_LIMIT = 200;

export interface BudgetProjectionRunOptions {
  builderPageSize?: number;
  builderConcurrency?: number;
  claimLimit?: number;
  eventConcurrency?: number;
  recoveryLimit?: number;
  reconciliationLimit?: number;
  workerId?: string;
}

export interface BudgetProjectionRunDependencies {
  store?: BudgetProjectionPostgresStore;
  target?: BudgetProjectionTarget;
}

export interface BudgetProjectionRunResult {
  worker_incarnation: string;
  scanned_builders: number;
  errors: number;
  recovered_leases: number;
  claimed_events: number;
  projected_events: number;
  already_present_events: number;
  lost_ack_recoveries: number;
  retry_scheduled: number;
  lease_lost: number;
  projection_conflicts: number;
  invalid_payloads: number;
  reconciliation_scanned: number;
  reconciliation_verified: number;
  reconciliation_missing: number;
  reconciliation_conflicts: number;
  reconciliation_errors: number;
  high_attempt_rows: number;
  exhausted_attempt_rows: number;
  pending_rows: number;
  processing_rows: number;
  projected_unverified_rows: number;
}

type EventOutcome =
  | 'projected'
  | 'already_present'
  | 'lost_ack_recovered'
  | 'retry'
  | 'lease_lost'
  | 'conflict'
  | 'invalid';

interface BuilderOutcome {
  recovered: number;
  claimed: number;
  events: EventOutcome[];
  reconciliation: Array<'verified' | 'missing' | 'conflict' | 'error'>;
  highAttempts: number;
  exhaustedAttempts: number;
  pending: number;
  processing: number;
  projectedUnverified: number;
}

class LeaseLostError extends Error {
  constructor() {
    super('The authoritative projection lease was lost');
    this.name = 'LeaseLostError';
  }
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function validateBuilderPage(
  builderIds: string[],
  afterBuilderId: string | null,
  limit: number,
): string[] {
  if (builderIds.length > limit) throw new Error('builder page exceeded its requested limit');
  let previous = afterBuilderId;
  for (const builderId of builderIds) {
    if (typeof builderId !== 'string' || builderId.length === 0) {
      throw new Error('builder page contained an invalid identity');
    }
    if (previous !== null && builderId <= previous) {
      throw new Error('builder page must be strictly ordered after its cursor');
    }
    previous = builderId;
  }
  return builderIds;
}

function opaqueReference(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function workerUuid(workerId: string): string {
  return workerId.slice('budget-projection:'.length);
}

function safeFailure(code: string, error: unknown): BudgetProjectionFailure {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  return {
    code,
    // Persist only the class, never a raw ClickHouse/transport message that
    // could contain a URL, credential, payload, or provider detail.
    message: `Authoritative analytics projection failed (${errorType})`,
  };
}

async function renewOrThrow(
  store: BudgetProjectionPostgresStore,
  lease: BudgetProjectionLease,
): Promise<BudgetProjectionLease> {
  const renewed = await store.renew(lease);
  if (!renewed) throw new LeaseLostError();
  return renewed;
}

async function releaseSafely(
  store: BudgetProjectionPostgresStore,
  lease: BudgetProjectionLease,
  failure: BudgetProjectionFailure,
): Promise<'retry' | 'lease_lost'> {
  try {
    return (await store.releaseForRetry(lease, failure)) ? 'retry' : 'lease_lost';
  } catch {
    return 'lease_lost';
  }
}

async function finishMatched(
  store: BudgetProjectionPostgresStore,
  lease: BudgetProjectionLease,
  outcome: 'already_present' | 'lost_ack_recovered' | 'projected',
): Promise<EventOutcome> {
  return (await store.markProjected(lease)) ? outcome : 'lease_lost';
}

async function handleInspectionFailure(
  store: BudgetProjectionPostgresStore,
  lease: BudgetProjectionLease,
  inspection: BudgetProjectionInspection,
): Promise<EventOutcome | null> {
  if (inspection.state === 'conflict') {
    const released = await releaseSafely(store, lease, {
      code: 'PROJECTION_HASH_CONFLICT',
      message: 'ClickHouse contains a conflicting authoritative event identity',
    });
    return released === 'retry' ? 'conflict' : 'lease_lost';
  }
  return null;
}

async function processLease(
  store: BudgetProjectionPostgresStore,
  target: BudgetProjectionTarget,
  originalLease: BudgetProjectionLease,
): Promise<EventOutcome> {
  let lease = originalLease;
  let payload;
  try {
    payload = parseAuthoritativeBudgetCostEventPayload(lease.payload);
    if (payload.builder_id !== lease.builder_id || payload.event_id !== lease.event_id) {
      throw new Error('Outbox typed identity disagrees with its immutable payload');
    }
  } catch (error) {
    const released = await releaseSafely(
      store,
      lease,
      safeFailure('PROJECTION_PAYLOAD_INVALID', error),
    );
    return released === 'retry' ? 'invalid' : 'lease_lost';
  }

  // Inspect before insertion. This is the durable lost-ack recovery path: a
  // prior worker may have committed the ClickHouse part and crashed before it
  // could advance PostgreSQL.
  let initialInspection: BudgetProjectionInspection;
  try {
    initialInspection = await target.inspect(lease.builder_id, lease.event_id, lease.payload_hash);
    lease = await renewOrThrow(store, lease);
  } catch (error) {
    if (error instanceof LeaseLostError) return 'lease_lost';
    return releaseSafely(store, lease, safeFailure('PROJECTION_INSPECTION_FAILED', error));
  }

  const initialFailure = await handleInspectionFailure(store, lease, initialInspection);
  if (initialFailure) return initialFailure;
  if (initialInspection.state === 'matched') {
    return finishMatched(store, lease, 'already_present');
  }

  let insertFailed: unknown;
  try {
    await target.insert(payload, lease.payload_hash);
  } catch (error) {
    insertFailed = error;
  }

  try {
    lease = await renewOrThrow(store, lease);
  } catch {
    return 'lease_lost';
  }

  let finalInspection: BudgetProjectionInspection;
  try {
    // Always verify after INSERT, including when the client observed an error.
    // A match after an error proves that ClickHouse durably accepted the write
    // and only its acknowledgement was lost.
    finalInspection = await target.inspect(lease.builder_id, lease.event_id, lease.payload_hash);
    lease = await renewOrThrow(store, lease);
  } catch (error) {
    if (error instanceof LeaseLostError) return 'lease_lost';
    return releaseSafely(
      store,
      lease,
      safeFailure(
        insertFailed === undefined ? 'PROJECTION_VERIFICATION_FAILED' : 'PROJECTION_INSERT_FAILED',
        insertFailed ?? error,
      ),
    );
  }

  const finalFailure = await handleInspectionFailure(store, lease, finalInspection);
  if (finalFailure) return finalFailure;
  if (finalInspection.state === 'matched') {
    return finishMatched(
      store,
      lease,
      insertFailed === undefined ? 'projected' : 'lost_ack_recovered',
    );
  }

  return releaseSafely(
    store,
    lease,
    safeFailure(
      insertFailed === undefined ? 'PROJECTION_NOT_VISIBLE' : 'PROJECTION_INSERT_FAILED',
      insertFailed ?? new Error('Synchronous insert was not visible to verification'),
    ),
  );
}

async function reconcileItem(
  store: BudgetProjectionPostgresStore,
  target: BudgetProjectionTarget,
  item: BudgetProjectionReconciliationItem,
): Promise<'verified' | 'missing' | 'conflict' | 'error'> {
  try {
    const inspection = await target.inspect(item.builder_id, item.event_id, item.payload_hash);
    if (inspection.state === 'missing') return 'missing';
    if (inspection.state === 'conflict') return 'conflict';
    return (await store.markVerified(item)) ? 'verified' : 'error';
  } catch {
    return 'error';
  }
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  callback: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const chunk = values.slice(offset, offset + concurrency);
    results.push(...(await Promise.all(chunk.map(callback))));
  }
  return results;
}

async function listFairReconciliationItems(
  store: BudgetProjectionPostgresStore,
  builderId: string,
  workerId: string,
  limit: number,
): Promise<BudgetProjectionReconciliationItem[]> {
  // A fresh invocation UUID is a uniformly distributed pivot over UUID-keyed
  // outbox rows. Persistent early missing/conflict rows therefore cannot own
  // the first page forever. Wrap once to the start to fill the bounded page.
  const pivot = workerUuid(workerId);
  const afterPivot = await store.listReconciliationItems(builderId, pivot, limit);
  if (afterPivot.length > limit || afterPivot.some((item) => item.outbox_id <= pivot)) {
    throw new Error('reconciliation page violated its UUID cursor boundary');
  }
  if (afterPivot.length === limit) return afterPivot;

  const wrapped = await store.listReconciliationItems(builderId, null, limit - afterPivot.length);
  const seen = new Set(afterPivot.map((item) => item.outbox_id));
  const result = [...afterPivot];
  for (const item of wrapped) {
    if (item.outbox_id > pivot || seen.has(item.outbox_id)) continue;
    seen.add(item.outbox_id);
    result.push(item);
  }
  return result;
}

async function processBuilder(
  builderId: string,
  workerId: string,
  store: BudgetProjectionPostgresStore,
  target: BudgetProjectionTarget,
  options: Required<Omit<BudgetProjectionRunOptions, 'workerId'>>,
): Promise<BuilderOutcome> {
  const recovered = await store.recoverExpiredLeases(builderId, workerId, options.recoveryLimit);
  const events: EventOutcome[] = [];
  let claimed = 0;
  // Claim only work that can start immediately. Pre-claiming the full per-tenant
  // limit while processing in smaller chunks lets queued one-minute leases
  // expire before their first inspection when ClickHouse is merely slow.
  while (claimed < options.claimLimit) {
    const batchLimit = Math.min(options.eventConcurrency, options.claimLimit - claimed);
    const leases = await store.claim(builderId, workerId, batchLimit);
    if (leases.length === 0) break;
    claimed += leases.length;
    events.push(...(await Promise.all(leases.map((lease) => processLease(store, target, lease)))));
    if (leases.length < batchLimit) break;
  }
  const reconciliationItems = await listFairReconciliationItems(
    store,
    builderId,
    workerId,
    options.reconciliationLimit,
  );
  const reconciliation = await mapBounded(reconciliationItems, options.eventConcurrency, (item) =>
    reconcileItem(store, target, item),
  );
  const status = await store.status(builderId);
  return {
    recovered,
    claimed,
    events,
    reconciliation,
    highAttempts: status.high_attempt_rows,
    exhaustedAttempts: status.exhausted_attempt_rows,
    pending: status.pending,
    processing: status.processing,
    projectedUnverified: status.projected_unverified,
  };
}

function count<T>(values: readonly T[], expected: T): number {
  return values.filter((value) => value === expected).length;
}

export function budgetProjectionRunFailedSystemically(result: BudgetProjectionRunResult): boolean {
  if (result.scanned_builders > 0 && result.errors >= result.scanned_builders) return true;
  return (
    result.claimed_events > 0 &&
    result.projected_events === 0 &&
    result.already_present_events === 0 &&
    result.lost_ack_recoveries === 0 &&
    result.retry_scheduled +
      result.lease_lost +
      result.projection_conflicts +
      result.invalid_payloads >=
      result.claimed_events
  );
}

export async function runBudgetCostEventProjection(
  rawOptions: BudgetProjectionRunOptions = {},
  dependencies: BudgetProjectionRunDependencies = {},
): Promise<BudgetProjectionRunResult> {
  const options: Required<Omit<BudgetProjectionRunOptions, 'workerId'>> = {
    builderPageSize: positiveInteger(
      'builderPageSize',
      rawOptions.builderPageSize ?? DEFAULT_BUILDER_PAGE_SIZE,
      1_000,
    ),
    builderConcurrency: positiveInteger(
      'builderConcurrency',
      rawOptions.builderConcurrency ?? DEFAULT_BUILDER_CONCURRENCY,
      25,
    ),
    claimLimit: positiveInteger('claimLimit', rawOptions.claimLimit ?? DEFAULT_CLAIM_LIMIT, 100),
    eventConcurrency: positiveInteger(
      'eventConcurrency',
      rawOptions.eventConcurrency ?? DEFAULT_EVENT_CONCURRENCY,
      20,
    ),
    recoveryLimit: positiveInteger(
      'recoveryLimit',
      rawOptions.recoveryLimit ?? DEFAULT_RECOVERY_LIMIT,
      100,
    ),
    reconciliationLimit: positiveInteger(
      'reconciliationLimit',
      rawOptions.reconciliationLimit ?? DEFAULT_RECONCILIATION_LIMIT,
      500,
    ),
  };
  const workerId = rawOptions.workerId ?? createBudgetProjectionWorkerId();
  assertBudgetProjectionWorkerId(workerId);
  const store = dependencies.store ?? createBudgetProjectionPostgresStore();
  const target = dependencies.target ?? createBudgetProjectionTarget();
  const log = logger.child({ module: 'budget-projection.worker' });
  const result: BudgetProjectionRunResult = {
    // A hash preserves incarnation correlation without exposing an operational
    // worker token that authorizes outbox lifecycle transitions.
    worker_incarnation: opaqueReference(workerId),
    scanned_builders: 0,
    errors: 0,
    recovered_leases: 0,
    claimed_events: 0,
    projected_events: 0,
    already_present_events: 0,
    lost_ack_recoveries: 0,
    retry_scheduled: 0,
    lease_lost: 0,
    projection_conflicts: 0,
    invalid_payloads: 0,
    reconciliation_scanned: 0,
    reconciliation_verified: 0,
    reconciliation_missing: 0,
    reconciliation_conflicts: 0,
    reconciliation_errors: 0,
    high_attempt_rows: 0,
    exhausted_attempt_rows: 0,
    pending_rows: 0,
    processing_rows: 0,
    projected_unverified_rows: 0,
  };

  let cursor: string | null = null;
  for (;;) {
    const builderIds = validateBuilderPage(
      await store.listBuilderPage(cursor, options.builderPageSize),
      cursor,
      options.builderPageSize,
    );
    if (builderIds.length === 0) break;

    for (let offset = 0; offset < builderIds.length; offset += options.builderConcurrency) {
      const builderBatch = builderIds.slice(offset, offset + options.builderConcurrency);
      result.scanned_builders += builderBatch.length;
      const settled = await Promise.allSettled(
        builderBatch.map((builderId) =>
          processBuilder(builderId, workerId, store, target, options),
        ),
      );
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index]!;
        if (outcome.status === 'rejected') {
          result.errors += 1;
          log.error(
            {
              builder_ref: opaqueReference(builderBatch[index] ?? 'unknown'),
              error_type: outcome.reason instanceof Error ? outcome.reason.name : 'UnknownError',
            },
            'authoritative projection failed for builder',
          );
          continue;
        }
        const value = outcome.value;
        result.recovered_leases += value.recovered;
        result.claimed_events += value.claimed;
        result.projected_events += count(value.events, 'projected');
        result.already_present_events += count(value.events, 'already_present');
        result.lost_ack_recoveries += count(value.events, 'lost_ack_recovered');
        result.retry_scheduled += count(value.events, 'retry');
        result.lease_lost += count(value.events, 'lease_lost');
        result.projection_conflicts += count(value.events, 'conflict');
        result.invalid_payloads += count(value.events, 'invalid');
        result.reconciliation_scanned += value.reconciliation.length;
        result.reconciliation_verified += count(value.reconciliation, 'verified');
        result.reconciliation_missing += count(value.reconciliation, 'missing');
        result.reconciliation_conflicts += count(value.reconciliation, 'conflict');
        result.reconciliation_errors += count(value.reconciliation, 'error');
        result.high_attempt_rows += value.highAttempts;
        result.exhausted_attempt_rows += value.exhaustedAttempts;
        result.pending_rows += value.pending;
        result.processing_rows += value.processing;
        result.projected_unverified_rows += value.projectedUnverified;
      }
    }

    cursor = builderIds.at(-1) ?? cursor;
    if (builderIds.length < options.builderPageSize) break;
  }

  const logMethod = budgetProjectionRunFailedSystemically(result)
    ? log.error.bind(log)
    : log.info.bind(log);
  logMethod(result, 'authoritative budget projection cycle complete');
  return result;
}

export const __budgetProjectionWorkerTesting = {
  opaqueReference,
  processLease,
  reconcileItem,
  listFairReconciliationItems,
  safeFailure,
  validateBuilderPage,
};
