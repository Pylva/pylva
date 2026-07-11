// Fire-and-forget Redis publish for the dashboard real-time feed. cacheBreaker
// fail-open keeps SDK ingest latency unaffected when Redis is degraded
// (I-SSE-3/4). The single publishFeedMessage entrypoint takes a typed
// SseFeedMessage so callers cannot misshape the wire payload.

import type { SseFeedMessage } from '@pylva/shared';
import { redisClient } from '../redis/client.js';
import { cacheBreaker } from '../redis/circuit-breaker.js';
import { logger } from '../logger.js';

export function feedChannel(builderId: string): string {
  return `feed:${builderId}`;
}

export async function publishFeedMessage(
  builderId: string,
  message: SseFeedMessage,
): Promise<void> {
  try {
    const payload = JSON.stringify(message);
    await cacheBreaker.fire(async () => redisClient.publish(feedChannel(builderId), payload));
  } catch (err) {
    logger.warn(
      {
        module: 'realtime.publisher',
        builder_id: builderId,
        message_type: message.type,
        error: err instanceof Error ? err.message : String(err),
      },
      'failed to publish feed message — dashboard may briefly diverge',
    );
  }
}
