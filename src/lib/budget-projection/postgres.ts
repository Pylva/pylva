import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { acquireBudgetBuilderExclusiveLock } from '../budget-control/transaction.js';

const OUTBOX_ATTEMPT_MAX = 2_147_483_646;
const HIGH_ATTEMPT_ALERT_THRESHOLD = 100;
const WORKER_ID_PATTERN =
  /^budget-projection:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/;

let defaultSqlPromise: Promise<Sql> | undefined;

function defaultSql(): Promise<Sql> {
  defaultSqlPromise ??= import('../budget-control/runtime-posture.js')
    .then(({ getReadyBudgetControlSql }) => getReadyBudgetControlSql())
    .catch((error: unknown) => {
      // Transient attestation/database failures are retryable. Do not retain a
      // rejected pool promise for the lifetime of the projection process.
      defaultSqlPromise = undefined;
      throw error;
    });
  return defaultSqlPromise;
}

export interface BudgetProjectionLease {
  builder_id: string;
  outbox_id: string;
  event_id: string;
  payload_hash: string;
  payload: unknown;
  attempt: number;
  worker_id: string;
  locked_at: string;
  lock_expires_at: string;
}

export interface BudgetProjectionFailure {
  code: string;
  message: string;
}

export interface BudgetProjectionReconciliationItem {
  builder_id: string;
  outbox_id: string;
  event_id: string;
  payload_hash: string;
}

export interface BudgetProjectionStatus {
  pending: number;
  processing: number;
  projected_unverified: number;
  projected_verified: number;
  high_attempt_rows: number;
  exhausted_attempt_rows: number;
  oldest_pending_at: string | null;
  oldest_unverified_event_at: string | null;
  latest_authoritative_event_at: string | null;
  contiguous_verified_before: string | null;
  caught_up: boolean;
}

export interface BudgetProjectionBillingGate {
  closed: boolean;
  verified: boolean;
}

export interface BudgetProjectionPostgresStore {
  listBuilderPage(afterBuilderId: string | null, limit: number): Promise<string[]>;
  recoverExpiredLeases(builderId: string, workerId: string, limit: number): Promise<number>;
  claim(builderId: string, workerId: string, limit: number): Promise<BudgetProjectionLease[]>;
  renew(lease: BudgetProjectionLease): Promise<BudgetProjectionLease | null>;
  releaseForRetry(lease: BudgetProjectionLease, failure: BudgetProjectionFailure): Promise<boolean>;
  markProjected(lease: BudgetProjectionLease): Promise<boolean>;
  listReconciliationItems(
    builderId: string,
    afterOutboxId: string | null,
    limit: number,
  ): Promise<BudgetProjectionReconciliationItem[]>;
  markVerified(item: BudgetProjectionReconciliationItem): Promise<boolean>;
  status(builderId: string): Promise<BudgetProjectionStatus>;
  isVerifiedBefore(builderId: string, exclusiveEventTime: string): Promise<boolean>;
  billingGate(builderId: string, exclusiveEventTime: string): Promise<BudgetProjectionBillingGate>;
}

interface LeaseTextRow {
  builder_id_text: unknown;
  outbox_id_text: unknown;
  event_id_text: unknown;
  payload_hash_text: unknown;
  payload_text: unknown;
  attempt_text: unknown;
  locked_at: string;
  lock_expires_at: string;
}

interface ReconciliationTextRow {
  builder_id_text: unknown;
  outbox_id_text: unknown;
  event_id_text: unknown;
  payload_hash_text: unknown;
}

interface StatusTextRow {
  pending_text: unknown;
  processing_text: unknown;
  projected_unverified_text: unknown;
  projected_verified_text: unknown;
  high_attempt_rows_text: unknown;
  exhausted_attempt_rows_text: unknown;
  oldest_pending_at: unknown;
  oldest_unverified_event_at: unknown;
  latest_authoritative_event_at: unknown;
  contiguous_verified_before: unknown;
  caught_up_text: unknown;
}

const UUID_TEXT_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SHA256_TEXT_PATTERN = /^[0-9a-f]{64}$/;
const UTC_MILLISECOND_TEXT_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

function positiveLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`limit must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function assertUuidLike(value: string, name: string): void {
  if (!/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
}

export function createBudgetProjectionWorkerId(generate: () => string = randomUUID): string {
  const workerId = `budget-projection:${generate().toLowerCase()}`;
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new Error('worker identity generator did not return a canonical UUIDv4');
  }
  return workerId;
}

export function assertBudgetProjectionWorkerId(workerId: string): void {
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new TypeError('workerId must be a unique budget projection incarnation identity');
  }
}

function validateFailure(failure: BudgetProjectionFailure): BudgetProjectionFailure {
  if (!ERROR_CODE_PATTERN.test(failure.code)) {
    throw new TypeError('projection failure code must be an uppercase stable identifier');
  }
  if (
    failure.message.length < 1 ||
    failure.message.length > 1_000 ||
    /[\u0000-\u001f\u007f]/.test(failure.message)
  ) {
    throw new TypeError('projection failure message must be a safe bounded summary');
  }
  return failure;
}

function retryDelaySeconds(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 300;
  return Math.min(300, 2 ** Math.min(attempt - 1, 9));
}

async function withTenantWorker<T>(
  client: Sql,
  builderId: string,
  workerId: string,
  callback: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  assertUuidLike(builderId, 'builderId');
  assertBudgetProjectionWorkerId(workerId);
  return client.begin('isolation level read committed', async (transaction) => {
    await transaction`
      SELECT
        pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE),
        pg_catalog.set_config('app.outbox_worker_id', ${workerId}, TRUE)
    `;
    return callback(transaction);
  }) as Promise<T>;
}

function rowText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`projection query returned invalid ${field}`);
  return value;
}

function rowUuid(value: unknown, field: string): string {
  const parsed = rowText(value, field);
  if (!UUID_TEXT_PATTERN.test(parsed)) {
    throw new Error(`projection query returned invalid ${field}`);
  }
  return parsed;
}

function rowHash(value: unknown, field: string): string {
  const parsed = rowText(value, field);
  if (!SHA256_TEXT_PATTERN.test(parsed)) {
    throw new Error(`projection query returned invalid ${field}`);
  }
  return parsed;
}

function rowNonnegativeInteger(value: unknown, field: string): number {
  const parsed = rowText(value, field);
  if (!/^(?:0|[1-9]\d*)$/.test(parsed)) {
    throw new Error(`projection query returned invalid ${field}`);
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`projection query returned invalid ${field}`);
  }
  return number;
}

function rowBoolean(value: unknown, field: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`projection query returned invalid ${field}`);
}

function rowNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  const parsed = rowText(value, field);
  const date = new Date(parsed);
  if (
    !UTC_MILLISECOND_TEXT_PATTERN.test(parsed) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== parsed
  ) {
    throw new Error(`projection query returned invalid ${field}`);
  }
  return parsed;
}

function rowTimestamp(value: unknown, field: string): string {
  const parsed = rowNullableTimestamp(value, field);
  if (parsed === null) throw new Error(`projection query returned invalid ${field}`);
  return parsed;
}

function rowPayload(value: unknown): unknown {
  const text = rowText(value, 'payload_text');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('projection query returned invalid payload_text');
  }
}

function leaseFromRow(row: LeaseTextRow, workerId: string): BudgetProjectionLease {
  return {
    builder_id: rowUuid(row.builder_id_text, 'builder_id_text'),
    outbox_id: rowUuid(row.outbox_id_text, 'outbox_id_text'),
    event_id: rowUuid(row.event_id_text, 'event_id_text'),
    payload_hash: rowHash(row.payload_hash_text, 'payload_hash_text'),
    payload: rowPayload(row.payload_text),
    attempt: rowNonnegativeInteger(row.attempt_text, 'attempt_text'),
    worker_id: workerId,
    locked_at: rowTimestamp(row.locked_at, 'locked_at'),
    lock_expires_at: rowTimestamp(row.lock_expires_at, 'lock_expires_at'),
  };
}

function reconciliationFromRow(row: ReconciliationTextRow): BudgetProjectionReconciliationItem {
  return {
    builder_id: rowUuid(row.builder_id_text, 'builder_id_text'),
    outbox_id: rowUuid(row.outbox_id_text, 'outbox_id_text'),
    event_id: rowUuid(row.event_id_text, 'event_id_text'),
    payload_hash: rowHash(row.payload_hash_text, 'payload_hash_text'),
  };
}

function statusFromRow(row: StatusTextRow): BudgetProjectionStatus {
  return {
    pending: rowNonnegativeInteger(row.pending_text, 'pending_text'),
    processing: rowNonnegativeInteger(row.processing_text, 'processing_text'),
    projected_unverified: rowNonnegativeInteger(
      row.projected_unverified_text,
      'projected_unverified_text',
    ),
    projected_verified: rowNonnegativeInteger(
      row.projected_verified_text,
      'projected_verified_text',
    ),
    high_attempt_rows: rowNonnegativeInteger(row.high_attempt_rows_text, 'high_attempt_rows_text'),
    exhausted_attempt_rows: rowNonnegativeInteger(
      row.exhausted_attempt_rows_text,
      'exhausted_attempt_rows_text',
    ),
    oldest_pending_at: rowNullableTimestamp(row.oldest_pending_at, 'oldest_pending_at'),
    oldest_unverified_event_at: rowNullableTimestamp(
      row.oldest_unverified_event_at,
      'oldest_unverified_event_at',
    ),
    latest_authoritative_event_at: rowNullableTimestamp(
      row.latest_authoritative_event_at,
      'latest_authoritative_event_at',
    ),
    contiguous_verified_before: rowNullableTimestamp(
      row.contiguous_verified_before,
      'contiguous_verified_before',
    ),
    caught_up: rowBoolean(row.caught_up_text, 'caught_up_text'),
  };
}

export function createBudgetProjectionPostgresStore(client?: Sql): BudgetProjectionPostgresStore {
  return {
    async listBuilderPage(afterBuilderId, limit): Promise<string[]> {
      const resolvedClient = client ?? (await defaultSql());
      positiveLimit(limit, 1_000);
      if (afterBuilderId !== null) assertUuidLike(afterBuilderId, 'afterBuilderId');
      const rows = await resolvedClient<{ builder_id_text: unknown }[]>`
        SELECT builder_id::TEXT AS builder_id_text
        FROM public.pylva_budget_projection_actionable_builders(
          ${afterBuilderId}::UUID,
          ${limit}::INTEGER
        )
      `;
      return rows.map((row) => rowUuid(row.builder_id_text, 'builder_id_text'));
    },

    async recoverExpiredLeases(builderId, workerId, limit): Promise<number> {
      const resolvedClient = client ?? (await defaultSql());
      positiveLimit(limit, 100);
      return withTenantWorker(resolvedClient, builderId, workerId, async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          WITH expired AS MATERIALIZED (
            SELECT id, lock_owner, attempts, lock_expires_at
            FROM public.budget_cost_event_outbox
            WHERE builder_id = ${builderId}::UUID
              AND status = 'processing'
              AND lock_expires_at <= statement_timestamp()
            ORDER BY lock_expires_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE public.budget_cost_event_outbox AS outbox
          SET status = 'pending',
              available_at = statement_timestamp(),
              last_error_code = 'LEASE_EXPIRED',
              last_error_message = 'Previous projection worker lease expired'
          FROM expired
          WHERE outbox.builder_id = ${builderId}::UUID
            AND outbox.id = expired.id
            AND outbox.status = 'processing'
            AND outbox.lock_owner = expired.lock_owner
            AND outbox.attempts = expired.attempts
            AND outbox.lock_expires_at = expired.lock_expires_at
          RETURNING outbox.id
        `;
        return rows.length;
      });
    },

    async claim(builderId, workerId, limit): Promise<BudgetProjectionLease[]> {
      const resolvedClient = client ?? (await defaultSql());
      positiveLimit(limit, 100);
      return withTenantWorker(resolvedClient, builderId, workerId, async (transaction) => {
        const rows = await transaction<LeaseTextRow[]>`
          WITH candidates AS MATERIALIZED (
            SELECT id, attempts
            FROM public.budget_cost_event_outbox
            WHERE builder_id = ${builderId}::UUID
              AND status = 'pending'
              AND available_at <= statement_timestamp()
              AND attempts < ${OUTBOX_ATTEMPT_MAX}
            ORDER BY available_at ASC, created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE public.budget_cost_event_outbox AS outbox
          SET status = 'processing', attempts = outbox.attempts + 1
          FROM candidates
          WHERE outbox.builder_id = ${builderId}::UUID
            AND outbox.id = candidates.id
            AND outbox.status = 'pending'
            AND outbox.attempts = candidates.attempts
          RETURNING
            outbox.builder_id::TEXT AS builder_id_text,
            outbox.id::TEXT AS outbox_id_text,
            outbox.cost_event_id::TEXT AS event_id_text,
            outbox.payload_hash::TEXT AS payload_hash_text,
            outbox.payload::TEXT AS payload_text,
            outbox.attempts::TEXT AS attempt_text,
            public.pylva_budget_timestamp_text(outbox.locked_at) AS locked_at,
            public.pylva_budget_timestamp_text(outbox.lock_expires_at) AS lock_expires_at
        `;
        return rows.map((row) => leaseFromRow(row, workerId));
      });
    },

    async renew(lease): Promise<BudgetProjectionLease | null> {
      const resolvedClient = client ?? (await defaultSql());
      return withTenantWorker(
        resolvedClient,
        lease.builder_id,
        lease.worker_id,
        async (transaction) => {
          const rows = await transaction<LeaseTextRow[]>`
          UPDATE public.budget_cost_event_outbox AS outbox
          SET lock_expires_at = outbox.lock_expires_at + INTERVAL '1 millisecond'
          WHERE outbox.builder_id = ${lease.builder_id}::UUID
            AND outbox.id = ${lease.outbox_id}::UUID
            AND outbox.cost_event_id = ${lease.event_id}::UUID
            AND outbox.payload_hash = ${lease.payload_hash}
            AND outbox.status = 'processing'
            AND outbox.lock_owner = ${lease.worker_id}
            AND outbox.attempts = ${lease.attempt}
            AND outbox.locked_at = ${lease.locked_at}::TIMESTAMPTZ
            AND outbox.lock_expires_at = ${lease.lock_expires_at}::TIMESTAMPTZ
            AND outbox.lock_expires_at > statement_timestamp()
          RETURNING
            outbox.builder_id::TEXT AS builder_id_text,
            outbox.id::TEXT AS outbox_id_text,
            outbox.cost_event_id::TEXT AS event_id_text,
            outbox.payload_hash::TEXT AS payload_hash_text,
            outbox.payload::TEXT AS payload_text,
            outbox.attempts::TEXT AS attempt_text,
            public.pylva_budget_timestamp_text(outbox.locked_at) AS locked_at,
            public.pylva_budget_timestamp_text(outbox.lock_expires_at) AS lock_expires_at
        `;
          return rows[0] ? leaseFromRow(rows[0], lease.worker_id) : null;
        },
      );
    },

    async releaseForRetry(lease, rawFailure): Promise<boolean> {
      const resolvedClient = client ?? (await defaultSql());
      const failure = validateFailure(rawFailure);
      const delaySeconds = retryDelaySeconds(lease.attempt);
      return withTenantWorker(
        resolvedClient,
        lease.builder_id,
        lease.worker_id,
        async (transaction) => {
          const rows = await transaction<{ id: string }[]>`
          UPDATE public.budget_cost_event_outbox AS outbox
          SET status = 'pending',
              available_at = statement_timestamp() + ${delaySeconds} * INTERVAL '1 second',
              last_error_code = ${failure.code},
              last_error_message = ${failure.message}
          WHERE outbox.builder_id = ${lease.builder_id}::UUID
            AND outbox.id = ${lease.outbox_id}::UUID
            AND outbox.cost_event_id = ${lease.event_id}::UUID
            AND outbox.payload_hash = ${lease.payload_hash}
            AND outbox.status = 'processing'
            AND outbox.lock_owner = ${lease.worker_id}
            AND outbox.attempts = ${lease.attempt}
            AND outbox.locked_at = ${lease.locked_at}::TIMESTAMPTZ
            AND outbox.lock_expires_at = ${lease.lock_expires_at}::TIMESTAMPTZ
          RETURNING outbox.id
        `;
          return rows.length === 1;
        },
      );
    },

    async markProjected(lease): Promise<boolean> {
      const resolvedClient = client ?? (await defaultSql());
      return withTenantWorker(
        resolvedClient,
        lease.builder_id,
        lease.worker_id,
        async (transaction) => {
          const rows = await transaction<{ id: string }[]>`
          UPDATE public.budget_cost_event_outbox AS outbox
          SET status = 'projected'
          WHERE outbox.builder_id = ${lease.builder_id}::UUID
            AND outbox.id = ${lease.outbox_id}::UUID
            AND outbox.cost_event_id = ${lease.event_id}::UUID
            AND outbox.payload_hash = ${lease.payload_hash}
            AND outbox.status = 'processing'
            AND outbox.lock_owner = ${lease.worker_id}
            AND outbox.attempts = ${lease.attempt}
            AND outbox.locked_at = ${lease.locked_at}::TIMESTAMPTZ
            AND outbox.lock_expires_at = ${lease.lock_expires_at}::TIMESTAMPTZ
            AND outbox.lock_expires_at > statement_timestamp()
          RETURNING outbox.id
        `;
          return rows.length === 1;
        },
      );
    },

    async listReconciliationItems(builderId, afterOutboxId, limit) {
      const resolvedClient = client ?? (await defaultSql());
      positiveLimit(limit, 500);
      if (afterOutboxId !== null) assertUuidLike(afterOutboxId, 'afterOutboxId');
      const workerId = createBudgetProjectionWorkerId();
      return withTenantWorker(resolvedClient, builderId, workerId, async (transaction) => {
        const rows = afterOutboxId
          ? await transaction<ReconciliationTextRow[]>`
              SELECT builder_id::TEXT AS builder_id_text,
                     id::TEXT AS outbox_id_text,
                     cost_event_id::TEXT AS event_id_text,
                     payload_hash::TEXT AS payload_hash_text
              FROM public.budget_cost_event_outbox
              WHERE builder_id = ${builderId}::UUID
                AND status = 'projected'
                AND projection_verified_at IS NULL
                AND id > ${afterOutboxId}::UUID
              ORDER BY id ASC
              LIMIT ${limit}
            `
          : await transaction<ReconciliationTextRow[]>`
              SELECT builder_id::TEXT AS builder_id_text,
                     id::TEXT AS outbox_id_text,
                     cost_event_id::TEXT AS event_id_text,
                     payload_hash::TEXT AS payload_hash_text
              FROM public.budget_cost_event_outbox
              WHERE builder_id = ${builderId}::UUID
                AND status = 'projected'
                AND projection_verified_at IS NULL
              ORDER BY id ASC
              LIMIT ${limit}
            `;
        return rows.map(reconciliationFromRow);
      });
    },

    async markVerified(item): Promise<boolean> {
      const resolvedClient = client ?? (await defaultSql());
      const workerId = createBudgetProjectionWorkerId();
      return withTenantWorker(resolvedClient, item.builder_id, workerId, async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          UPDATE public.budget_cost_event_outbox AS outbox
          SET projection_verified_at = statement_timestamp()
          WHERE outbox.builder_id = ${item.builder_id}::UUID
            AND outbox.id = ${item.outbox_id}::UUID
            AND outbox.cost_event_id = ${item.event_id}::UUID
            AND outbox.payload_hash = ${item.payload_hash}
            AND outbox.status = 'projected'
            AND outbox.projection_verified_at IS NULL
          RETURNING outbox.id
        `;
        if (rows.length === 1) return true;

        // Overlapping cron invocations may reconcile the same immutable item.
        // If another verifier committed first, a fresh READ COMMITTED statement
        // must recognize that exact terminal row as success rather than raising
        // a false scheduler alarm. Keep mismatched identities/hashes fail-closed.
        const verified = await transaction<{ verified_text: unknown }[]>`
          SELECT CASE WHEN EXISTS (
            SELECT 1
            FROM public.budget_cost_event_outbox AS outbox
            WHERE outbox.builder_id = ${item.builder_id}::UUID
              AND outbox.id = ${item.outbox_id}::UUID
              AND outbox.cost_event_id = ${item.event_id}::UUID
              AND outbox.payload_hash = ${item.payload_hash}
              AND outbox.status = 'projected'
              AND outbox.projection_verified_at IS NOT NULL
          ) THEN 'true' ELSE 'false' END AS verified_text
        `;
        return rowBoolean(verified[0]?.verified_text, 'verified_text');
      });
    },

    async status(builderId): Promise<BudgetProjectionStatus> {
      const resolvedClient = client ?? (await defaultSql());
      const workerId = createBudgetProjectionWorkerId();
      return withTenantWorker(resolvedClient, builderId, workerId, async (transaction) => {
        const rows = await transaction<StatusTextRow[]>`
          WITH facts AS (
            SELECT
              outbox.status,
              outbox.attempts,
              outbox.available_at,
              outbox.projection_verified_at,
              COALESCE(
                usage.committed_at,
                (outbox.payload->>'timestamp')::TIMESTAMPTZ,
                outbox.created_at
              ) AS committed_at
            FROM public.budget_cost_event_outbox AS outbox
            LEFT JOIN public.budget_usage_ledger AS usage
              ON usage.builder_id = outbox.builder_id
             AND usage.id = outbox.usage_ledger_id
             AND usage.cost_event_id = outbox.cost_event_id
            WHERE outbox.builder_id = ${builderId}::UUID
          ), aggregate AS (
            SELECT
              COUNT(*) FILTER (WHERE status = 'pending')::INTEGER AS pending,
              COUNT(*) FILTER (WHERE status = 'processing')::INTEGER AS processing,
              COUNT(*) FILTER (
                WHERE status = 'projected' AND projection_verified_at IS NULL
              )::INTEGER AS projected_unverified,
              COUNT(*) FILTER (
                WHERE status = 'projected' AND projection_verified_at IS NOT NULL
              )::INTEGER AS projected_verified,
              COUNT(*) FILTER (
                WHERE status <> 'projected'
                  AND attempts >= ${HIGH_ATTEMPT_ALERT_THRESHOLD}
              )::INTEGER AS high_attempt_rows,
              COUNT(*) FILTER (
                WHERE status <> 'projected' AND attempts >= ${OUTBOX_ATTEMPT_MAX}
              )::INTEGER
                AS exhausted_attempt_rows,
              MIN(available_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
              MIN(committed_at) FILTER (WHERE projection_verified_at IS NULL)
                AS oldest_unverified_event_at,
              MAX(committed_at) AS latest_authoritative_event_at
            FROM facts
          )
          SELECT
            pending::TEXT AS pending_text,
            processing::TEXT AS processing_text,
            projected_unverified::TEXT AS projected_unverified_text,
            projected_verified::TEXT AS projected_verified_text,
            high_attempt_rows::TEXT AS high_attempt_rows_text,
            exhausted_attempt_rows::TEXT AS exhausted_attempt_rows_text,
            public.pylva_budget_timestamp_text(oldest_pending_at) AS oldest_pending_at,
            public.pylva_budget_timestamp_text(oldest_unverified_event_at)
              AS oldest_unverified_event_at,
            public.pylva_budget_timestamp_text(latest_authoritative_event_at)
              AS latest_authoritative_event_at,
            public.pylva_budget_timestamp_text(oldest_unverified_event_at)
              AS contiguous_verified_before,
            CASE WHEN oldest_unverified_event_at IS NULL
              THEN 'true' ELSE 'false'
            END AS caught_up_text
          FROM aggregate
        `;
        if (!rows[0]) throw new Error('projection status query returned no row');
        return statusFromRow(rows[0]);
      });
    },

    async isVerifiedBefore(builderId, exclusiveEventTime): Promise<boolean> {
      const resolvedClient = client ?? (await defaultSql());
      if (!Number.isFinite(Date.parse(exclusiveEventTime))) {
        throw new TypeError('exclusiveEventTime must be a valid timestamp');
      }
      const workerId = createBudgetProjectionWorkerId();
      return withTenantWorker(resolvedClient, builderId, workerId, async (transaction) => {
        const rows = await transaction<{ verified_text: unknown }[]>`
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1
            FROM public.budget_cost_event_outbox
            WHERE builder_id = ${builderId}::UUID
              AND projection_verified_at IS NULL
              AND (payload->>'timestamp')::TIMESTAMPTZ < ${exclusiveEventTime}::TIMESTAMPTZ
          ) THEN 'true' ELSE 'false' END AS verified_text
        `;
        return rowBoolean(rows[0]?.verified_text, 'verified_text');
      });
    },

    async billingGate(builderId, exclusiveEventTime): Promise<BudgetProjectionBillingGate> {
      const resolvedClient = client ?? (await defaultSql());
      if (!Number.isFinite(Date.parse(exclusiveEventTime))) {
        throw new TypeError('exclusiveEventTime must be a valid timestamp');
      }
      const workerId = createBudgetProjectionWorkerId();
      return withTenantWorker(resolvedClient, builderId, workerId, async (transaction) => {
        // Lifecycle commits hold the matching shared builder lock. Taking the
        // exclusive form here creates a commit barrier: an already-open usage
        // transaction must publish its outbox row before billing can prove the
        // closed period is fully projected, while later commits wait and take
        // a server timestamp after this short gate transaction.
        await acquireBudgetBuilderExclusiveLock(transaction, builderId);
        const rows = await transaction<Array<{ closed_text: unknown; verified_text: unknown }>>`
          SELECT
            CASE WHEN ${exclusiveEventTime}::TIMESTAMPTZ <= statement_timestamp()
              THEN 'true' ELSE 'false'
            END AS closed_text,
            CASE WHEN ${exclusiveEventTime}::TIMESTAMPTZ <= statement_timestamp()
              AND NOT EXISTS (
                SELECT 1
                FROM public.budget_cost_event_outbox
                WHERE builder_id = ${builderId}::UUID
                  AND projection_verified_at IS NULL
                  AND (payload->>'timestamp')::TIMESTAMPTZ
                        < ${exclusiveEventTime}::TIMESTAMPTZ
              ) THEN 'true' ELSE 'false'
            END AS verified_text
        `;
        if (!rows[0]) return { closed: false, verified: false };
        return {
          closed: rowBoolean(rows[0].closed_text, 'closed_text'),
          verified: rowBoolean(rows[0].verified_text, 'verified_text'),
        };
      });
    },
  };
}

export const __budgetProjectionPostgresTesting = {
  highAttemptAlertThreshold: HIGH_ATTEMPT_ALERT_THRESHOLD,
  outboxAttemptMax: OUTBOX_ATTEMPT_MAX,
  resetDefaultSql: (): void => {
    defaultSqlPromise = undefined;
  },
  retryDelaySeconds,
  validateFailure,
};
