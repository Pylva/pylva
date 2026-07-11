// GET /api/v1/feed/stream — Server-Sent Events transport for the dashboard
// real-time cost feed.
//
// I-SSE-1: dashboard JWT (cookie) — middleware enforces.
// I-SSE-2: max 50 connections per builder (429 once exceeded).
// I-SSE-3: Redis down → heartbeat-only stream; never throws to client.
// I-SSE-5: initial snapshot reuses dashboard-queries getOverview + getTopEndUsers.
// I-SSE-7: explicit headers (Cache-Control, X-Accel-Buffering, Content-Type).
// I-SSE-10: ENABLE_SSE_FEED kill switch returns 503 with FEATURE_NOT_AVAILABLE.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode, type SseFeedMessage } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../lib/auth/builder-context.js';
import { apiError, rateLimitError } from '../../../../../lib/errors.js';
import { env } from '../../../../../lib/config.js';
import { logger } from '../../../../../lib/logger.js';
import { acquireSseConnection } from '../../../../../lib/realtime/sse-manager.js';
import { subscribeFeed } from '../../../../../lib/realtime/feed-subscriber.js';
import { getOverview, getTopEndUsers } from '../../../../../lib/clickhouse/dashboard-queries.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_INTERVAL_MS = 30_000;
// Track 2 PR 2.1 (per O2): rebroadcast a fresh snapshot every 30s so
// dropped Redis pub/sub messages self-heal without a full reconnect.
const SNAPSHOT_REFRESH_INTERVAL_MS = 30_000;
const SNAPSHOT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECONNECT_HINT_MS = 3_000;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!env.ENABLE_SSE_FEED) {
    return apiError(
      503,
      'api_error',
      ErrorCode.FEATURE_NOT_AVAILABLE,
      'Real-time feed is disabled',
    );
  }

  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { builderId } = ctx;

  const lease = acquireSseConnection(builderId);
  if (!lease.ok) {
    logger.info(
      {
        module: 'realtime.stream',
        builder_id: builderId,
        current: lease.current,
        limit: lease.limit,
      },
      'sse connection limit reached',
    );
    return rateLimitError(60);
  }

  const log = logger.child({ module: 'realtime.stream', builder_id: builderId });
  const encoder = new TextEncoder();

  // Shared so the stream's `cancel` callback can run the SAME teardown as an
  // abort — releasing the lease alone (the old behavior) leaked the heartbeat
  // timer and the Redis subscription consumer.
  let cleanupRef: (() => Promise<void>) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let snapshotTimer: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => Promise<void>) | null = null;

      const cleanup = async (): Promise<void> => {
        if (closed) return;
        // Flip `closed` synchronously BEFORE any await below: an abort and the
        // stream `cancel` both route here on disconnect, and the single-threaded
        // gate is what stops a double unsubscribe/close. Do not move an `await`
        // above this line.
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (snapshotTimer) clearInterval(snapshotTimer);
        if (unsubscribe) {
          try {
            await unsubscribe();
          } catch {
            /* swallow */
          }
        }
        lease.release();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanupRef = cleanup;

      // Register disconnect handling BEFORE the snapshot/subscribe await below.
      // addEventListener('abort', ...) on an already-aborted signal never fires
      // (WHATWG), so a client that disconnects WHILE the snapshot query is in
      // flight would otherwise leave the heartbeat timer, the connection-slot
      // lease, and the Redis subscription consumer leaked forever. Check
      // `.aborted` explicitly to cover the already-disconnected case.
      if (request.signal.aborted) {
        await cleanup();
        return;
      }
      request.signal.addEventListener('abort', () => {
        void cleanup();
      });

      const safeEnqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Write failed (client disconnected mid-write or controller torn
          // down by a proxy). Proactively cleanup so we don't keep the
          // heartbeat timer + lease alive waiting on an abort that may not
          // come through proxy-reset edge cases.
          void cleanup();
        }
      };

      // Start the heartbeat first so a slow snapshot doesn't leave the
      // connection silent past the ALB idle threshold.
      heartbeatTimer = setInterval(() => {
        safeEnqueue(`: heartbeat ${Date.now()}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);

      // EventSource backoff hint on disconnect.
      safeEnqueue(`retry: ${RECONNECT_HINT_MS}\n\n`);

      // Subscribe before the snapshot completes so live messages emitted
      // mid-fetch aren't lost. subscribeFeed fails open: a Redis outage
      // returns a no-op handle and the connection still streams heartbeats
      // (I-SSE-3).
      const livePromise = subscribeFeed(builderId, (message: SseFeedMessage) => {
        safeEnqueue(sseFrame(message.type, message.data));
      });

      const now = new Date();
      const from = new Date(now.getTime() - SNAPSHOT_LOOKBACK_MS);
      const range = { from, to: now };

      const snapshotPromise = Promise.all([
        getOverview(builderId, range),
        getTopEndUsers(builderId, range, 20),
      ]).catch((err) => {
        log.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'sse snapshot failed — streaming heartbeat-only initially',
        );
        return null as null;
      });

      const [snapshot, subscription] = await Promise.all([snapshotPromise, livePromise]);

      // The client may have disconnected while we were awaiting the snapshot.
      // In that case `cleanup` already ran with `unsubscribe` still null, so
      // tear down the just-resolved subscription here — otherwise the Redis
      // consumer leaks — and bail before arming the periodic snapshot timer.
      if (closed) {
        try {
          await subscription.unsubscribe();
        } catch {
          /* removeConsumer swallows today; keep this branch defensive */
        }
        return;
      }
      unsubscribe = subscription.unsubscribe;

      if (snapshot) {
        const [overview, topCustomers] = snapshot;
        safeEnqueue(
          sseFrame('snapshot', {
            range: { from: from.toISOString(), to: now.toISOString() },
            overview,
            top_customers: topCustomers,
          }),
        );
      } else {
        safeEnqueue(sseFrame('snapshot', { range: null, overview: null, top_customers: [] }));
      }

      // Track 2 PR 2.1 (O2): periodic snapshot merge — every 30s refresh
      // overview + top end-users so any Redis pub/sub gaps self-heal. One
      // ClickHouse query pair per 30s per stream is the documented cost.
      snapshotTimer = setInterval(() => {
        if (closed) return;
        void (async () => {
          const refreshNow = new Date();
          const refreshFrom = new Date(refreshNow.getTime() - SNAPSHOT_LOOKBACK_MS);
          try {
            const [overview, topCustomers] = await Promise.all([
              getOverview(builderId, { from: refreshFrom, to: refreshNow }),
              getTopEndUsers(builderId, { from: refreshFrom, to: refreshNow }, 20),
            ]);
            safeEnqueue(
              sseFrame('snapshot', {
                range: { from: refreshFrom.toISOString(), to: refreshNow.toISOString() },
                overview,
                top_customers: topCustomers,
              }),
            );
          } catch (err) {
            log.warn(
              { error: err instanceof Error ? err.message : String(err) },
              'sse periodic snapshot failed — continuing with live deltas only',
            );
          }
        })();
      }, SNAPSHOT_REFRESH_INTERVAL_MS);

      // (Disconnect teardown is wired up before the snapshot await above.)
    },
    cancel: () => {
      // Stream cancelled by the consumer (e.g. a proxy reset that doesn't also
      // surface as a request abort). Run the full teardown — releasing the
      // lease alone would leak the heartbeat/snapshot timers and the Redis
      // subscription consumer. Falls back to a bare lease release if `start`
      // hasn't assigned the cleanup ref yet.
      if (cleanupRef) {
        void cleanupRef();
      } else {
        lease.release();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    },
  });
}
