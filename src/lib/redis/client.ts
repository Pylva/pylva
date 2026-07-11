// Redis client via official redis package
// Decision #15: redis (official) replaces ioredis

import { createClient, type RedisClientType } from 'redis';
import { env } from '../config.js';

// Command connection (general operations)
const redisClient: RedisClientType = createClient({
  url: env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries: number) => Math.min(retries * 100, 5000),
  },
});

// Dedicated pub/sub connection — cannot share with command connection
const redisPubSubClient: RedisClientType = createClient({
  url: env.REDIS_URL,
  socket: {
    reconnectStrategy: (retries: number) => Math.min(retries * 100, 5000),
  },
});

redisClient.on('error', (err) => {
  console.error('[redis:command] connection error:', err.message);
});

redisPubSubClient.on('error', (err) => {
  console.error('[redis:pubsub] connection error:', err.message);
});

let connected = false;
let commandConnectPromise: Promise<void> | null = null;
let pubSubConnectPromise: Promise<void> | null = null;

async function connectCommandClient(): Promise<void> {
  if (redisClient.isOpen) return;
  commandConnectPromise ??= redisClient.connect().then(
    () => {
      commandConnectPromise = null;
    },
    (err) => {
      commandConnectPromise = null;
      throw err;
    },
  );
  await commandConnectPromise;
}

async function connectPubSubClient(): Promise<void> {
  if (redisPubSubClient.isOpen) return;
  pubSubConnectPromise ??= redisPubSubClient.connect().then(
    () => {
      pubSubConnectPromise = null;
    },
    (err) => {
      pubSubConnectPromise = null;
      throw err;
    },
  );
  await pubSubConnectPromise;
}

/**
 * Lazy command-client connect for callers OUTSIDE the server bundle's module
 * graph. Next's nodejs middleware bundles its OWN copy of this module, so the
 * instrumentation-time connectRedis() never connected *its* client — every
 * middleware Redis call failed instantly (ClientClosedError) and the circuit
 * breakers fell open. Cheap no-op once connected (isOpen guard).
 */
export async function ensureRedisCommandClient(): Promise<void> {
  await connectCommandClient();
}

/**
 * Connect both Redis clients. Must be called at server startup.
 * pub/sub listener is initialized eagerly — lazy init misses revocation events.
 */
export async function connectRedis(): Promise<void> {
  if (connected) return;
  await Promise.all([connectCommandClient(), connectPubSubClient()]);
  connected = true;
}

export async function closeRedis(): Promise<void> {
  await Promise.all([redisClient.quit(), redisPubSubClient.quit()]);
  connected = false;
}

export async function pingRedis(): Promise<boolean> {
  try {
    await connectCommandClient();
    const result = await redisClient.ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

export { redisClient, redisPubSubClient };
