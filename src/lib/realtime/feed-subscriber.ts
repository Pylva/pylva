// B3-T2 — Redis pub/sub subscription helpers for SSE connections. D3: per
// builder channel `feed:{builder_id}`. Multiple SSE connections per builder
// share one SUBSCRIBE; we ref-count listeners and UNSUBSCRIBE only when the
// last consumer drops. I-SSE-3: subscribe failures degrade the connection to
// heartbeat-only — they never throw.

import type { SseFeedMessage } from '@pylva/shared';
import { redisPubSubClient } from '../redis/client.js';
import { logger } from '../logger.js';
import { feedChannel } from './feed-publisher.js';

type ChannelListener = (raw: string) => void;

interface ChannelEntry {
  consumers: Set<MessageHandler>;
  rawListener: ChannelListener;
  // Resolves true once the redis SUBSCRIBE is confirmed, false if it failed.
  // Concurrent first-subscribers await this shared promise instead of each
  // issuing their own SUBSCRIBE (see subscribeFeed for why).
  ready: Promise<boolean>;
}

export type MessageHandler = (message: SseFeedMessage) => void;

const channelRegistry = new Map<string, ChannelEntry>();

function parseMessage(raw: string): SseFeedMessage | null {
  try {
    const parsed = JSON.parse(raw) as SseFeedMessage;
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export interface FeedSubscription {
  unsubscribe: () => Promise<void>;
}

/**
 * Subscribe an SSE connection to the builder's feed channel. Returns an
 * unsubscribe handle the caller MUST invoke when the connection closes —
 * otherwise listener references leak across reconnects.
 *
 * On Redis subscribe failure: logs a warning and returns a no-op handle so
 * the SSE connection still streams heartbeats + initial snapshot (I-SSE-3).
 */
export async function subscribeFeed(
  builderId: string,
  handler: MessageHandler,
): Promise<FeedSubscription> {
  const channel = feedChannel(builderId);
  let entry = channelRegistry.get(channel);

  if (!entry) {
    // Register the entry SYNCHRONOUSLY (no await between the get above and the
    // set below) so two connections opening in the same tick coalesce onto one
    // SUBSCRIBE. The previous code awaited the SUBSCRIBE before set()ing, so
    // concurrent first-subscribers each created their own entry + raw listener;
    // only the last survived in the registry and the earlier listeners (each
    // pinning its SSE controller) could never be UNSUBSCRIBEd → leak.
    const consumers = new Set<MessageHandler>();
    const rawListener: ChannelListener = (raw) => {
      const message = parseMessage(raw);
      if (!message) return;
      for (const consumer of consumers) {
        try {
          consumer(message);
        } catch (err) {
          logger.warn(
            {
              module: 'realtime.subscriber',
              error: err instanceof Error ? err.message : String(err),
            },
            'consumer threw while handling feed message',
          );
        }
      }
    };

    // Wrap in an async IIFE so a synchronous throw from subscribe() is handled
    // identically to a rejected promise — subscribe failures must never throw
    // out of subscribeFeed (I-SSE-3).
    const ready = (async () => {
      await redisPubSubClient.subscribe(channel, rawListener);
      return true;
    })().catch((err) => {
      logger.warn(
        {
          module: 'realtime.subscriber',
          builder_id: builderId,
          error: err instanceof Error ? err.message : String(err),
        },
        'redis subscribe failed; SSE will stream heartbeats only',
      );
      // Drop the failed entry so a later connection retries the SUBSCRIBE
      // instead of inheriting a dead channel. Identity-check before deleting so
      // a stale rejection can never evict a healthy successor entry.
      if (channelRegistry.get(channel) === entry) channelRegistry.delete(channel);
      return false;
    });

    entry = { consumers, rawListener, ready };
    channelRegistry.set(channel, entry);
  }

  entry.consumers.add(handler);

  const ok = await entry.ready;
  if (!ok) {
    // SUBSCRIBE failed (I-SSE-3): degrade to heartbeat-only. Drop our handler
    // and hand back a no-op so caller disconnect logic stays uniform.
    entry.consumers.delete(handler);
    return { unsubscribe: async () => {} };
  }

  return { unsubscribe: () => removeConsumer(channel, handler) };
}

async function removeConsumer(channel: string, handler: MessageHandler): Promise<void> {
  const entry = channelRegistry.get(channel);
  if (!entry) return;
  entry.consumers.delete(handler);
  if (entry.consumers.size > 0) return;
  channelRegistry.delete(channel);
  try {
    await redisPubSubClient.unsubscribe(channel, entry.rawListener);
  } catch (err) {
    logger.warn(
      {
        module: 'realtime.subscriber',
        channel,
        error: err instanceof Error ? err.message : String(err),
      },
      'redis unsubscribe failed',
    );
  }
}

// Test-only reset hook.
export function _resetFeedSubscriberForTests(): void {
  channelRegistry.clear();
}
