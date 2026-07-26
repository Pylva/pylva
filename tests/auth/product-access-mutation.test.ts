import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBuilderEntitlementForShare: vi.fn(),
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/db/advisory-locks.js', () => ({
  getBuilderEntitlementForShare: mocks.getBuilderEntitlementForShare,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: mocks.withRLS,
}));

const {
  ProductAccessMutationDeniedError,
  withProductAccessMutation,
} = await import('../../src/lib/auth/product-access-mutation.js');

const ACTIVE_RESOLUTION = {
  ok: true as const,
  entitlement: {
    plan: 'pro' as const,
    access_state: 'active' as const,
    entitlement_source: 'stripe' as const,
    has_product_access: true,
    legacy_free: false,
  },
};

describe('withProductAccessMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getBuilderEntitlementForShare.mockResolvedValue(ACTIVE_RESOLUTION);
  });

  it('fails closed without invoking the mutation for a restricted lifecycle row', async () => {
    const tx = { id: 'same-transaction' };
    const mutation = vi.fn();
    mocks.withRLS.mockImplementation(
      async (_builderId: string, callback: (value: unknown) => Promise<unknown>) =>
        callback(tx),
    );
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: {
        plan: null,
        access_state: 'suspended',
        entitlement_source: 'stripe',
        has_product_access: false,
        legacy_free: false,
      },
    });

    await expect(withProductAccessMutation('builder-a', mutation)).rejects.toBeInstanceOf(
      ProductAccessMutationDeniedError,
    );
    expect(mocks.getBuilderEntitlementForShare).toHaveBeenCalledWith(tx, 'builder-a');
    expect(mutation).not.toHaveBeenCalled();
  });

  it('holds the lifecycle transaction through a paused post-check mutation boundary', async () => {
    const tx = { id: 'locked-transaction' };
    let resumeMutation!: () => void;
    let signalMutationStarted!: () => void;
    let signalTransactionReleased!: () => void;
    const mutationStarted = new Promise<void>((resolve) => {
      signalMutationStarted = resolve;
    });
    const pausedMutation = new Promise<void>((resolve) => {
      resumeMutation = resolve;
    });
    const transactionReleased = new Promise<void>((resolve) => {
      signalTransactionReleased = resolve;
    });
    const order: string[] = [];

    mocks.withRLS.mockImplementation(
      async (_builderId: string, callback: (value: unknown) => Promise<unknown>) => {
        try {
          return await callback(tx);
        } finally {
          signalTransactionReleased();
        }
      },
    );

    const mutation = withProductAccessMutation('builder-a', async (receivedTx) => {
      expect(receivedTx).toBe(tx);
      signalMutationStarted();
      await pausedMutation;
      order.push('mutation');
      return 'written';
    });
    await mutationStarted;

    let suspensionCommitted = false;
    const suspension = transactionReleased.then(() => {
      suspensionCommitted = true;
      order.push('suspension');
    });
    await Promise.resolve();
    expect(suspensionCommitted).toBe(false);

    resumeMutation();
    await expect(mutation).resolves.toBe('written');
    await suspension;
    expect(order).toEqual(['mutation', 'suspension']);
    expect(mocks.getBuilderEntitlementForShare).toHaveBeenCalledWith(tx, 'builder-a');
  });
});
