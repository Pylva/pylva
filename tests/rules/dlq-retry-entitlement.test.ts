import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeBuilderCapability: vi.fn(),
  auditLog: vi.fn(),
  externalFetch: vi.fn(),
  getBuilderEntitlementForShare: vi.fn(),
  withProductAccessMutation: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('../../src/lib/db/advisory-locks.js', () => ({
  getBuilderEntitlementForShare: mocks.getBuilderEntitlementForShare,
}));

vi.mock('../../src/lib/auth/product-access-mutation.js', () => ({
  isProductAccessMutationDeniedError: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'product_access_mutation_denied',
  withProductAccessMutation: mocks.withProductAccessMutation,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('../../src/lib/external-egress.js', () => ({
  externalFetch: mocks.externalFetch,
}));

const { deliverFromSnapshot, retryDlqEntry } = await import('../../src/lib/alerts/dlq-retry.js');

describe('DLQ replay workspace lifecycle gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: true });
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: { has_product_access: true },
    });
    mocks.withProductAccessMutation.mockImplementation(
      async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) => callback({}),
    );
  });

  it('locks lifecycle state before the DLQ row and does not replay without product access', async () => {
    const execute = vi.fn();
    mocks.withRLS.mockImplementation(
      async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({ execute }),
    );
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: { has_product_access: false },
    });

    await expect(
      retryDlqEntry({
        builderId: 'builder-a',
        dlqId: '00000000-0000-4000-8000-000000000001',
        actorUserId: 'user-a',
      }),
    ).resolves.toEqual({ kind: 'access_denied' });

    expect(mocks.getBuilderEntitlementForShare).toHaveBeenCalledWith(
      expect.anything(),
      'builder-a',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.externalFetch).not.toHaveBeenCalled();
  });

  it('fails rather than reporting lifecycle denial when the entitlement lock query fails', async () => {
    const execute = vi.fn();
    mocks.withRLS.mockImplementation(
      async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({ execute }),
    );
    mocks.getBuilderEntitlementForShare.mockRejectedValue(new Error('postgres unavailable'));

    await expect(
      retryDlqEntry({
        builderId: 'builder-a',
        dlqId: '00000000-0000-4000-8000-000000000001',
        actorUserId: 'user-a',
      }),
    ).rejects.toThrow('postgres unavailable');

    expect(mocks.externalFetch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('holds the lifecycle lock through send, delete, and success audit', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: '00000000-0000-4000-8000-000000000001',
          channel: 'webhook',
          webhook_config_id: '00000000-0000-4000-8000-000000000002',
          event_type: 'rule.fired',
          payload: { event: 'test' },
          snapshot: {
            url: 'https://alerts.example.test/webhook',
            secret: 'secret',
          },
          attempts: 2,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.withRLS.mockImplementation(
      async (_builderId: string, callback: (tx: unknown) => Promise<unknown>) =>
        callback({ execute }),
    );
    mocks.externalFetch.mockResolvedValue({
      status: 204,
      statusText: 'No Content',
      headers: {},
      body: '',
    });

    await expect(
      retryDlqEntry({
        builderId: 'builder-a',
        dlqId: '00000000-0000-4000-8000-000000000001',
        actorUserId: 'user-a',
      }),
    ).resolves.toEqual({ kind: 'success', channel: 'webhook' });

    expect(mocks.externalFetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    // No second, unlocked entitlement lookup is needed: FOR SHARE remains
    // held by the surrounding transaction through all three side effects.
    expect(mocks.authorizeBuilderCapability).not.toHaveBeenCalled();
    expect(mocks.withProductAccessMutation).not.toHaveBeenCalled();
  });

  it('sends nothing when a direct snapshot replay loses access at its final boundary', async () => {
    const denied = new Error('product access denied') as Error & { code: string };
    denied.code = 'product_access_mutation_denied';
    mocks.withProductAccessMutation.mockRejectedValue(denied);

    await expect(
      deliverFromSnapshot('builder-a', {
        id: '00000000-0000-4000-8000-000000000001',
        channel: 'webhook',
        webhook_config_id: '00000000-0000-4000-8000-000000000002',
        event_type: 'rule.fired',
        payload: { event: 'test' },
        snapshot: {
          url: 'https://alerts.example.test/webhook',
          secret: 'secret',
        },
        attempts: 2,
      }),
    ).resolves.toEqual({
      ok: false,
      error: 'access_denied',
      access_denied: true,
    });

    expect(mocks.externalFetch).not.toHaveBeenCalled();
    expect(mocks.withProductAccessMutation).toHaveBeenCalledTimes(1);
  });
});
