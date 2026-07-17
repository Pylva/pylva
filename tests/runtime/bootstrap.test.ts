import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectRedis: vi.fn(async () => undefined),
  initApiKeyRevocationListener: vi.fn(async () => undefined),
  loggerInfo: vi.fn(),
  registerBatcherShutdown: vi.fn(),
  validateProductionSecrets: vi.fn(),
  assertGeneralAppRuntimeReadyForProduction: vi.fn(async () => undefined),
  assertBudgetControlRuntimeReadyForProduction: vi.fn(async () => undefined),
  assertBudgetProjectionClickHouseReadyForProduction: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/alerts/batcher.integration.js', () => ({
  registerBatcherShutdown: mocks.registerBatcherShutdown,
}));

vi.mock('../../src/lib/config-guards.js', () => ({
  validateProductionSecrets: mocks.validateProductionSecrets,
}));

vi.mock('../../src/lib/budget-control/runtime-posture.js', () => ({
  assertBudgetControlRuntimeReadyForProduction: mocks.assertBudgetControlRuntimeReadyForProduction,
}));

vi.mock('../../src/lib/db/general-app-runtime-posture.js', () => ({
  assertGeneralAppRuntimeReadyForProduction: mocks.assertGeneralAppRuntimeReadyForProduction,
}));

vi.mock('../../src/lib/budget-projection/clickhouse-posture.js', () => ({
  assertBudgetProjectionClickHouseReadyForProduction:
    mocks.assertBudgetProjectionClickHouseReadyForProduction,
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
  mocks.assertGeneralAppRuntimeReadyForProduction.mockReset();
  mocks.assertGeneralAppRuntimeReadyForProduction.mockImplementation(async () => undefined);
  mocks.assertBudgetControlRuntimeReadyForProduction.mockReset();
  mocks.assertBudgetControlRuntimeReadyForProduction.mockImplementation(async () => undefined);
  mocks.assertBudgetProjectionClickHouseReadyForProduction.mockReset();
  mocks.assertBudgetProjectionClickHouseReadyForProduction.mockImplementation(
    async () => undefined,
  );
});

describe('runtime bootstrap', () => {
  it('starts Node runtime services once', async () => {
    const bootstrapNodeRuntime = await loadBootstrap();

    await Promise.all([bootstrapNodeRuntime(), bootstrapNodeRuntime()]);

    expect(mocks.registerBatcherShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.assertGeneralAppRuntimeReadyForProduction).toHaveBeenCalledTimes(1);
    expect(mocks.assertBudgetControlRuntimeReadyForProduction).toHaveBeenCalledTimes(1);
    expect(mocks.assertBudgetProjectionClickHouseReadyForProduction).toHaveBeenCalledTimes(1);
    expect(mocks.connectRedis).toHaveBeenCalledTimes(1);
    expect(mocks.initApiKeyRevocationListener).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
    expect(
      mocks.assertGeneralAppRuntimeReadyForProduction.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.assertBudgetControlRuntimeReadyForProduction.mock.invocationCallOrder[0]!);
  });

  it('fails before authoritative attestation and services when the general login is unsafe', async () => {
    const bootstrapNodeRuntime = await loadBootstrap();
    mocks.assertGeneralAppRuntimeReadyForProduction.mockRejectedValueOnce(
      new Error('unsafe general-app role'),
    );

    await expect(bootstrapNodeRuntime()).rejects.toThrow('unsafe general-app role');
    expect(mocks.assertBudgetControlRuntimeReadyForProduction).not.toHaveBeenCalled();
    expect(mocks.assertBudgetProjectionClickHouseReadyForProduction).not.toHaveBeenCalled();
    expect(mocks.registerBatcherShutdown).not.toHaveBeenCalled();
    expect(mocks.connectRedis).not.toHaveBeenCalled();
    expect(mocks.initApiKeyRevocationListener).not.toHaveBeenCalled();
  });

  it('fails before runtime services when the authoritative database posture is unsafe', async () => {
    const bootstrapNodeRuntime = await loadBootstrap();
    mocks.assertBudgetControlRuntimeReadyForProduction.mockRejectedValueOnce(
      new Error('unsafe budget-control role'),
    );

    await expect(bootstrapNodeRuntime()).rejects.toThrow('unsafe budget-control role');
    expect(mocks.assertGeneralAppRuntimeReadyForProduction).toHaveBeenCalledTimes(1);
    expect(mocks.registerBatcherShutdown).not.toHaveBeenCalled();
    expect(mocks.assertBudgetProjectionClickHouseReadyForProduction).not.toHaveBeenCalled();
    expect(mocks.connectRedis).not.toHaveBeenCalled();
    expect(mocks.initApiKeyRevocationListener).not.toHaveBeenCalled();
  });

  it('fails before runtime services when the authoritative ClickHouse posture is unsafe', async () => {
    const bootstrapNodeRuntime = await loadBootstrap();
    mocks.assertBudgetProjectionClickHouseReadyForProduction.mockRejectedValueOnce(
      new Error('unsafe budget-projection role'),
    );

    await expect(bootstrapNodeRuntime()).rejects.toThrow('unsafe budget-projection role');
    expect(mocks.assertBudgetControlRuntimeReadyForProduction).toHaveBeenCalledTimes(1);
    expect(mocks.assertBudgetProjectionClickHouseReadyForProduction).toHaveBeenCalledTimes(1);
    expect(mocks.registerBatcherShutdown).not.toHaveBeenCalled();
    expect(mocks.connectRedis).not.toHaveBeenCalled();
    expect(mocks.initApiKeyRevocationListener).not.toHaveBeenCalled();
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
