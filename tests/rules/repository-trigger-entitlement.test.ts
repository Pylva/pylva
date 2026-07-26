import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ProductAccessMutationDeniedError extends Error {
    readonly code = 'product_access_mutation_denied';

    constructor(readonly builderId: string) {
      super('Mutation denied because the workspace has no product access');
      this.name = 'ProductAccessMutationDeniedError';
    }
  }

  return {
    ProductAccessMutationDeniedError,
    returning: vi.fn(),
    withProductAccessMutation: vi.fn(),
  };
});

vi.mock('../../src/lib/auth/product-access-mutation.js', () => ({
  ProductAccessMutationDeniedError: mocks.ProductAccessMutationDeniedError,
  isProductAccessMutationDeniedError: (error: unknown) =>
    error instanceof mocks.ProductAccessMutationDeniedError,
  withProductAccessMutation: mocks.withProductAccessMutation,
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: vi.fn(),
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/lib/budget-control/rule-revisions.js', () => ({
  reconcileBudgetRuleRevisionInTransaction: vi.fn(),
  withBudgetRuleRevisionMutation: vi.fn(),
}));

vi.mock('../../src/lib/budget-control/transaction.js', () => ({
  pgJsonbParameterText: vi.fn(),
  withBudgetBuilderTransaction: vi.fn(),
}));

const { markRuleTriggered, markRuleTriggeredWithProductAccess } =
  await import('../../src/lib/rules/repository.js');

const tx = {
  update: () => ({
    set: () => ({
      where: () => ({
        returning: mocks.returning,
      }),
    }),
  }),
};

describe('lifecycle-locked rule trigger stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withProductAccessMutation.mockImplementation(
      async (_builderId: string, mutation: (value: unknown) => Promise<unknown>) =>
        mutation(tx),
    );
    mocks.returning.mockResolvedValue([{ id: 'rule-a' }]);
  });

  it('updates through the transaction supplied by the lifecycle lock helper', async () => {
    await expect(
      markRuleTriggeredWithProductAccess('builder-a', 'rule-a'),
    ).resolves.toEqual({ kind: 'updated' });
    expect(mocks.withProductAccessMutation).toHaveBeenCalledWith(
      'builder-a',
      expect.any(Function),
    );
    expect(mocks.returning).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a missing rule from a lifecycle denial', async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await expect(
      markRuleTriggeredWithProductAccess('builder-a', 'missing-rule'),
    ).resolves.toEqual({ kind: 'rule_not_found' });

    mocks.withProductAccessMutation.mockRejectedValueOnce(
      new mocks.ProductAccessMutationDeniedError('builder-a'),
    );
    await expect(
      markRuleTriggeredWithProductAccess('builder-a', 'rule-a'),
    ).resolves.toEqual({ kind: 'access_denied' });
  });

  it('keeps the legacy wrapper fail-closed on lifecycle denial', async () => {
    mocks.withProductAccessMutation.mockRejectedValueOnce(
      new mocks.ProductAccessMutationDeniedError('builder-a'),
    );

    await expect(markRuleTriggered('builder-a', 'rule-a')).rejects.toMatchObject({
      code: 'product_access_mutation_denied',
    });
    expect(mocks.returning).not.toHaveBeenCalled();
  });
});
