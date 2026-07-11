// ClickHouse client via @clickhouse/client
// Spec Section 4.6: Storage Architecture

import { createClient, type ClickHouseSettings } from '@clickhouse/client';
import { env } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'clickhouse.client' });

// keep_alive/request_timeout pin the library defaults so behavior cannot
// drift across client upgrades. idle_socket_ttl must stay below the
// server-side HTTP keep_alive_timeout (ClickHouse default 3s; LBs may drop
// idle sockets sooner) so idle sockets are discarded instead of reused. A
// socket can still die between the TTL check and the write — that residual
// race is absorbed by the transient-error retry in queryCostEvents.
const clickhouse = createClient({
  url: env.CLICKHOUSE_URL,
  keep_alive: { enabled: true, idle_socket_ttl: 2500 },
  // Per-attempt transport ceiling. This is the only bound for callers that
  // do not pass timeoutMs (billing usage aggregation, health cron) — do not
  // lower it without auditing those paths.
  request_timeout: 30_000,
});

export { clickhouse };

function sanitizeClickHouseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  return raw
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|password|secret|token)=\S+/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export interface QueryCostEventsOptions {
  queryId?: string;
  queryLabel?: string;
  timeoutMs?: number;
  clickhouseSettings?: ClickHouseSettings;
}

const QUERY_MAX_ATTEMPTS = 2;
const QUERY_RETRY_BACKOFF_MS = 250;

const TRANSIENT_SOCKET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
]);

// Read-path retry gate, deliberately narrow: only connection-drop errors — a
// stale keep-alive socket the server/LB closed while the app sat idle, the
// signature of the first-request-after-idle failure. These fail in
// milliseconds, so a retry costs ~backoff only. Timeouts and aborts are
// excluded on purpose: retrying a timed-out attempt doubles the caller's
// latency budget, and because the abandoned server-side query can keep
// running under the old query_id, it doubles ClickHouse load exactly when it
// is already slow. The dashboard recovers from timeouts via the error card's
// auto-refresh instead. Query-level failures (syntax, auth, unknown table,
// duplicate query_id) never match and fail fast.
function isTransientClickHouseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && TRANSIENT_SOCKET_CODES.has(code)) return true;
  // @clickhouse/client stringly-typed dropped-connection errors:
  // 'socket hang up', UNEXPECTED_END_OF_FILE (32), NETWORK_ERROR (210).
  return /socket hang up|UNEXPECTED_END_OF_FILE|NETWORK_ERROR/i.test(err.message);
}

/**
 * Insert telemetry events in batch.
 * builder_id is populated from the authenticated API key context — NOT from the SDK.
 */
export async function insertCostEvents(events: Array<Record<string, unknown>>): Promise<void> {
  if (events.length === 0) return;

  await clickhouse.insert({
    table: 'cost_events',
    values: events,
    format: 'JSONEachRow',
    // Wait for the async insert flush so ingest can roll back Redis dedupe
    // markers when ClickHouse rejects the batch.
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  });
}

/**
 * Query cost events with mandatory builder_id filter.
 * All ClickHouse queries MUST include builder_id in the WHERE clause.
 * Reads are idempotent, so connection-drop failures get one fast retry;
 * timeouts do not retry (see isTransientClickHouseError).
 */
export async function queryCostEvents(
  builderId: string,
  query: string,
  params: Record<string, unknown> = {},
  options: QueryCostEventsOptions = {},
): Promise<unknown[]> {
  const clickhouseSettings =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? {
          max_execution_time: Math.ceil(options.timeoutMs / 1000),
          ...options.clickhouseSettings,
        }
      : options.clickhouseSettings;

  for (let attempt = 1; attempt <= QUERY_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = performance.now();
    // Per attempt: an aborted AbortSignal stays aborted, and a client-side
    // abort can leave the server-side query running — reusing its query_id
    // would be rejected with QUERY_WITH_SAME_ID_IS_ALREADY_RUNNING (216).
    // The retry suffix keeps the caller's UUID-based id unique and greppable.
    const abortSignal =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;
    const queryId =
      options.queryId === undefined || attempt === 1
        ? options.queryId
        : `${options.queryId}.retry${attempt - 1}`;

    try {
      const result = await clickhouse.query({
        query,
        query_params: { ...params, builder_id: builderId },
        format: 'JSONEachRow',
        ...(queryId ? { query_id: queryId } : {}),
        ...(abortSignal ? { abort_signal: abortSignal } : {}),
        ...(clickhouseSettings ? { clickhouse_settings: clickhouseSettings } : {}),
      });

      return await result.json();
    } catch (err) {
      const willRetry = attempt < QUERY_MAX_ATTEMPTS && isTransientClickHouseError(err);
      log.warn(
        {
          builder_id: builderId,
          query_id: queryId,
          query_label: options.queryLabel,
          attempt,
          max_attempts: QUERY_MAX_ATTEMPTS,
          will_retry: willRetry,
          elapsed_ms: Math.round(performance.now() - startedAt),
          error: sanitizeClickHouseError(err),
        },
        'clickhouse query failed',
      );
      if (!willRetry) throw err;
      await new Promise((resolve) => setTimeout(resolve, QUERY_RETRY_BACKOFF_MS));
    }
  }

  // Unreachable: the final attempt either returned or threw above.
  throw new Error('clickhouse query retry loop exhausted');
}

export async function closeClickhouse(): Promise<void> {
  await clickhouse.close();
}
