// B2a T4a — batcher integration. Wires the in-process batcher into
// process-lifecycle signals so an ECS task termination flushes pending
// batches synchronously (I-T4a-9). SIGKILL is still lossy by design.
//
// Called once at server startup from wherever the Next.js app bootstraps
// background services (e.g. `instrumentation.ts`).

import { flushAll } from './batcher.js';
import { deliverCoalescedAlert } from './delivery.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'alerts.batcher.integration' });

type ShutdownGlobal = typeof globalThis & {
  __pylvaBatcherShutdownRegistered?: boolean;
};

const shutdownGlobal = globalThis as ShutdownGlobal;

export async function flushPendingAlertBatchesForShutdown(): Promise<void> {
  log.info('SIGTERM received — flushing pending alert batches');
  try {
    await flushAll(deliverCoalescedAlert);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'shutdown alert batch flush failed');
  }
}

export function registerBatcherShutdown(): void {
  if (shutdownGlobal.__pylvaBatcherShutdownRegistered) return;
  shutdownGlobal.__pylvaBatcherShutdownRegistered = true;

  const flush = () => flushPendingAlertBatchesForShutdown();

  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
  // Do NOT register on uncaughtException — that's handled higher up.
}
