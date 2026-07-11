import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  flushAll: vi.fn(),
  deliverCoalescedAlert: vi.fn(),
}));

vi.mock('../../src/lib/alerts/batcher.js', () => ({
  flushAll: mocks.flushAll,
}));

vi.mock('../../src/lib/alerts/delivery.js', () => ({
  deliverCoalescedAlert: mocks.deliverCoalescedAlert,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: () => undefined, error: () => undefined }),
  },
}));

type ShutdownGlobal = typeof globalThis & {
  __pylvaBatcherShutdownRegistered?: boolean;
};

describe('registerBatcherShutdown()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as ShutdownGlobal).__pylvaBatcherShutdownRegistered;
  });

  it('does not add duplicate process listeners across module reloads', async () => {
    const processOn = vi.spyOn(process, 'on');
    processOn.mockImplementation((() => process) as typeof process.on);

    const first = await import('../../src/lib/alerts/batcher.integration.js');
    first.registerBatcherShutdown();
    first.registerBatcherShutdown();

    vi.resetModules();
    const second = await import('../../src/lib/alerts/batcher.integration.js');
    second.registerBatcherShutdown();

    expect(processOn).toHaveBeenCalledTimes(2);
    expect(processOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(processOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));

    processOn.mockRestore();
  });

  it('flushes pending batches through the canonical delivery path and awaits completion', async () => {
    let resolveFlush!: () => void;
    const pendingFlush = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    mocks.flushAll.mockReturnValue(pendingFlush);

    const module = await import('../../src/lib/alerts/batcher.integration.js');

    let settled = false;
    const flushPromise = module.flushPendingAlertBatchesForShutdown();
    void flushPromise.then(() => {
      settled = true;
    });

    expect(mocks.flushAll).toHaveBeenCalledWith(mocks.deliverCoalescedAlert);
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFlush();
    await flushPromise;
    expect(settled).toBe(true);
  });
});
