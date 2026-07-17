import { randomUUID } from 'node:crypto';
import {
  authoritativePayloadToClickHouseRow,
  type AuthoritativeBudgetCostEventPayload,
} from './contracts.js';

export const AUTHORITATIVE_BUDGET_COST_EVENT_TABLE = 'budget_cost_events' as const;

interface JsonResult {
  json(): Promise<unknown>;
}

export interface BudgetProjectionClickHouseClient {
  insert(input: {
    table: string;
    values: Array<Record<string, unknown>>;
    format: 'JSONEachRow';
    clickhouse_settings?: Record<string, unknown>;
  }): Promise<unknown>;
  query(input: {
    query: string;
    query_params: Record<string, unknown>;
    format: 'JSONEachRow';
    query_id?: string;
    abort_signal?: AbortSignal;
    clickhouse_settings?: Record<string, unknown>;
  }): Promise<JsonResult>;
}

export type BudgetProjectionInspection =
  | {
      state: 'missing';
      physical_rows: 0;
      logical_rows: 0;
      hashes: [];
    }
  | {
      state: 'matched';
      physical_rows: number;
      logical_rows: 1;
      hashes: [string];
    }
  | {
      state: 'conflict';
      physical_rows: number;
      logical_rows: number;
      hashes: string[];
    };

export interface BudgetProjectionTarget {
  insert(payload: AuthoritativeBudgetCostEventPayload, payloadHash: string): Promise<void>;
  inspect(
    builderId: string,
    eventId: string,
    expectedPayloadHash: string,
  ): Promise<BudgetProjectionInspection>;
}

function defaultClient(): Promise<BudgetProjectionClickHouseClient> {
  // The posture module owns the single bounded success cache. Adding a second
  // cache here would let an almost-expired attestation authorize a client for
  // another full TTL and nearly double the role-drift exposure window.
  return import('./clickhouse-posture.js')
    .then(({ getReadyBudgetProjectionClickHouseClient }) =>
      getReadyBudgetProjectionClickHouseClient(),
    )
    .then((client) => client as unknown as BudgetProjectionClickHouseClient);
}

interface InspectionRow {
  physical_rows?: unknown;
  hash_count?: unknown;
  hashes?: unknown;
  logical_rows?: unknown;
  logical_hash?: unknown;
}

function nonnegativeCount(value: unknown, field: string): number {
  if (
    typeof value !== 'number' &&
    (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value))
  ) {
    throw new Error(`ClickHouse projection inspection returned invalid ${field}`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`ClickHouse projection inspection returned invalid ${field}`);
  }
  return parsed;
}

function inspectionHashes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('ClickHouse projection inspection returned invalid hashes');
  }
  return [...new Set(value)].sort();
}

function parseInspection(raw: unknown, expectedPayloadHash: string): BudgetProjectionInspection {
  if (!Array.isArray(raw) || raw.length !== 1) {
    throw new Error('ClickHouse projection inspection must return exactly one aggregate row');
  }
  const row = raw[0] as InspectionRow;
  const physicalRows = nonnegativeCount(row.physical_rows, 'physical_rows');
  const hashCount = nonnegativeCount(row.hash_count, 'hash_count');
  const logicalRows = nonnegativeCount(row.logical_rows, 'logical_rows');
  const hashes = inspectionHashes(row.hashes);
  const logicalHash = row.logical_hash;

  if (physicalRows === 0 && hashCount === 0 && logicalRows === 0 && hashes.length === 0) {
    return { state: 'missing', physical_rows: 0, logical_rows: 0, hashes: [] };
  }
  if (
    physicalRows >= 1 &&
    hashCount === 1 &&
    hashes.length === 1 &&
    hashes[0] === expectedPayloadHash &&
    logicalRows === 1 &&
    logicalHash === expectedPayloadHash
  ) {
    return {
      state: 'matched',
      physical_rows: physicalRows,
      logical_rows: 1,
      hashes: [expectedPayloadHash],
    };
  }
  return { state: 'conflict', physical_rows: physicalRows, logical_rows: logicalRows, hashes };
}

export function createBudgetProjectionTarget(
  client?: BudgetProjectionClickHouseClient,
  timeoutMs = 25_000,
  resolveDefaultClient: () => Promise<BudgetProjectionClickHouseClient> = defaultClient,
): BudgetProjectionTarget {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 45_000) {
    throw new RangeError('timeoutMs must be an integer between 100 and 45000');
  }

  return {
    async insert(payload, payloadHash): Promise<void> {
      const resolvedClient = client ?? (await resolveDefaultClient());
      const row = authoritativePayloadToClickHouseRow(payload, payloadHash);
      await resolvedClient.insert({
        table: AUTHORITATIVE_BUDGET_COST_EVENT_TABLE,
        values: [row as unknown as Record<string, unknown>],
        format: 'JSONEachRow',
        // A successful response means the part is durable. ReplacingMergeTree
        // still makes retry-after-lost-ack safe at the FINAL read boundary.
        clickhouse_settings: { async_insert: 0, wait_for_async_insert: 1 },
      });
    },

    async inspect(builderId, eventId, expectedPayloadHash): Promise<BudgetProjectionInspection> {
      const resolvedClient = client ?? (await resolveDefaultClient());
      const response = await resolvedClient.query({
        query: `
          SELECT
            physical_rows,
            hash_count,
            hashes,
            (
              SELECT count()
              FROM budget_cost_events FINAL
              WHERE builder_id = {builder_id:String}
                AND event_id = {event_id:UUID}
            ) AS logical_rows,
            (
              SELECT if(count() = 0, '', any(toString(payload_hash)))
              FROM budget_cost_events FINAL
              WHERE builder_id = {builder_id:String}
                AND event_id = {event_id:UUID}
            ) AS logical_hash
          FROM (
            SELECT
              count() AS physical_rows,
              uniqExact(payload_hash) AS hash_count,
              arraySort(groupUniqArray(toString(payload_hash))) AS hashes
            FROM budget_cost_events
            WHERE builder_id = {builder_id:String}
              AND event_id = {event_id:UUID}
          )
        `,
        query_params: { builder_id: builderId, event_id: eventId },
        // Concurrent worker/reconciler invocations may inspect the same event.
        // A per-request suffix avoids ClickHouse QUERY_WITH_SAME_ID collisions.
        query_id: `budget-projection-verify-${eventId}-${randomUUID()}`,
        abort_signal: AbortSignal.timeout(timeoutMs),
        clickhouse_settings: { max_execution_time: Math.ceil(timeoutMs / 1_000) },
        format: 'JSONEachRow',
      });
      return parseInspection(await response.json(), expectedPayloadHash);
    },
  };
}

export const __budgetProjectionClickHouseTesting = {
  parseInspection,
};
