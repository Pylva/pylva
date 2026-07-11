import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectRedis: vi.fn(async () => undefined),
  initApiKeyRevocationListener: vi.fn(async () => undefined),
  loggerInfo: vi.fn(),
  registerBatcherShutdown: vi.fn(),
  validateProductionSecrets: vi.fn(),
}));

vi.mock('../../src/lib/alerts/batcher.integration.js', () => ({
  registerBatcherShutdown: mocks.registerBatcherShutdown,
}));

vi.mock('../../src/lib/config-guards.js', () => ({
  validateProductionSecrets: mocks.validateProductionSecrets,
}));

vi.mock('../../src/lib/auth/api-key.js', () => ({
  initApiKeyRevocationListener: mocks.initApiKeyRevocationListener,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    info: mocks.loggerInfo,
  },
}));

vi.mock('../../src/lib/redis/client.js', () => ({
  connectRedis: mocks.connectRedis,
}));

async function loadBootstrap() {
  vi.resetModules();
  const mod = await import('../../src/instrumentation.node.js');
  return mod.bootstrapNodeRuntime;
}

beforeEach(() => {
  mocks.connectRedis.mockReset();
  mocks.connectRedis.mockImplementation(async () => undefined);
  mocks.initApiKeyRevocationListener.mockReset();
  mocks.initApiKeyRevocationListener.mockImplementation(async () => undefined);
  mocks.loggerInfo.mockReset();
  mocks.registerBatcherShutdown.mockReset();
});

describe('runtime bootstrap', () => {
  it('starts Node runtime services once', async () => {
    const bootstrapNodeRuntime = await loadBootstrap();

    await Promise.all([bootstrapNodeRuntime(), bootstrapNodeRuntime()]);

    expect(mocks.registerBatcherShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.connectRedis).toHaveBeenCalledTimes(1);
    expect(mocks.initApiKeyRevocationListener).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed bootstrap', async () => {
    const bootstrapNodeRuntime = await loadBootstrap();

    mocks.connectRedis.mockRejectedValueOnce(new Error('transient redis'));

    await expect(bootstrapNodeRuntime()).rejects.toThrow('transient redis');
    await expect(bootstrapNodeRuntime()).resolves.toBeUndefined();

    expect(mocks.connectRedis).toHaveBeenCalledTimes(2);
    expect(mocks.registerBatcherShutdown).toHaveBeenCalledTimes(2);
    expect(mocks.initApiKeyRevocationListener).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
  });
});
