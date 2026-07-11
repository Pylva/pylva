// Redis-backed cross-batch dedup for ingest (B1 — §7.2).
//
// Strategy: one Redis SADD pipeline per batch. Key is scoped per builder +
// hour bucket so TTL cleanup is automatic. If Redis errors (or the cache
// circuit breaker is open), fail-open — the SDK-side LRU is the primary
// dedup layer anyway; Redis is belt-and-suspenders.
//
// Returns the set of span_ids that were newly added (i.e., not duplicates).
// Intra-batch duplicates are handled upstream of this call.

import { redisClient } from '../redis/client.js';
import { cacheBreaker } from '../redis/circuit-breaker.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'ingest.dedup' });

const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // hour-bucketed key + 2h TTL guards the boundary

function bucketKey(builderId: string, ts: Date): string {
  const hour = Math.floor(ts.getTime() / (60 * 60 * 1000));
  return `dedup:${builderId}:${hour}`;
}

/**
 * Given a list of (span_id, timestamp) pairs, return the subset that is NOT
 * already present in Redis for that builder. Fail-open on cache breaker open
 * or Redis error.
 */
export async function filterDuplicates(
  builderId: string,
  items: Array<{ span_id: string; timestamp: string }>,
): Promise<Set<string>> {
  if (items.length === 0) return new Set();

  try {
    const result = (await cacheBreaker.fire(async () => {
      const multi = redisClient.multi();
      const keysInOrder: string[] = [];
      for (const { span_id, timestamp } of items) {
        const key = bucketKey(builderId, new Date(timestamp));
        keysInOrder.push(key);
        multi.sAdd(key, span_id);
        multi.pExpire(key, TWO_HOURS_MS);
      }
      // replies[2*i] is sAdd result (1 = added, 0 = already present), replies[2*i+1] is pExpire.
      const replies = await multi.exec();
      return replies;
    })) as unknown[] | null;

    // null = circuit breaker open / Redis error — fail-open.
    if (result === null) {
      return new Set(items.map((i) => i.span_id));
    }

    const kept = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      // sAdd returns 1 when the member was newly added, 0 when it already existed.
      // Number() coerces across number / string / RESP3 Buffer reply variants.
      if (Number(result[i * 2]) === 1) {
        kept.add(items[i]!.span_id);
      }
    }
    return kept;
  } catch (err) {
    log.warn(
      { builder_id: builderId, error: err instanceof Error ? err.message : String(err) },
      'dedup Redis pipeline failed; fail-open (SDK LRU is primary)',
    );
    return new Set(items.map((i) => i.span_id));
  }
}

/**
 * Compensate for a failed ClickHouse insert after filterDuplicates claimed
 * span_ids in Redis. Only pass items that were newly kept for this request.
 */
export async function undoFilterDuplicates(
  builderId: string,
  keptItems: Array<{ span_id: string; timestamp: string }>,
): Promise<void> {
  if (keptItems.length === 0) return;

  try {
    const result = await cacheBreaker.fire(async () => {
      const multi = redisClient.multi();
      for (const { span_id, timestamp } of keptItems) {
        multi.sRem(bucketKey(builderId, new Date(timestamp)), span_id);
      }
      return multi.exec();
    });

    if (result === null) {
      log.warn(
        { builder_id: builderId, count: keptItems.length },
        'dedup undo skipped after Redis breaker fallback; span_ids remain claimed',
      );
    }
  } catch (err) {
    log.warn(
      {
        builder_id: builderId,
        count: keptItems.length,
        error: err instanceof Error ? err.message : String(err),
      },
      'dedup undo Redis pipeline failed; span_ids remain claimed',
    );
  }
}
