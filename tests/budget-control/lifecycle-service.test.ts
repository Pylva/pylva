import { describe, expect, it, vi } from 'vitest';
import type { TransactionSql } from 'postgres';

vi.mock('../../src/lib/db/client.js', () => ({
  sql: { begin: vi.fn() },
}));

import {
  BudgetLifecycleError,
  BudgetLifecyclePricingUnavailableError,
  BudgetLifecycleSchemaBlockerError,
  __budgetLifecycleTesting,
  calculateBudgetSettlement,
  priceActualUsageFromFrozenPricing,
} from '../../src/lib/budget-control/lifecycle-service.js';
import type { ParsedCommitUsageRequest } from '@pylva/shared';

const llmRequest = (overrides: Partial<ParsedCommitUsageRequest> = {}): ParsedCommitUsageRequest =>
  ({
    schema_version: '1.0',
    status: 'success',
    latency_ms: 125,
    stream_aborted: false,
    kind: 'llm',
    actual_input_tokens: 95,
    actual_output_tokens: 180,
    ...overrides,
  }) as ParsedCommitUsageRequest;

const toolRequest = (actualValue: string): ParsedCommitUsageRequest => ({
  schema_version: '1.0',
  status: 'success',
  latency_ms: 125,
  stream_aborted: false,
  kind: 'tool',
  actual_value: actualValue,
});

const llmContext = {
  kind: 'llm' as const,
  provider: 'openai',
  model: 'gpt-4o-mini',
  costSourceSlug: null,
  metric: null,
  pricingSnapshot: {
    schema_version: '1.0',
    kind: 'llm',
    provider: 'openai',
    model: 'gpt-4o-mini',
    input_per_million_usd: '0.15',
    output_per_million_usd: '0.6',
  },
};

const toolContext = {
  kind: 'tool' as const,
  provider: null,
  model: null,
  costSourceSlug: 'tavily-search',
  metric: 'credit',
  pricingSnapshot: {
    schema_version: '1.0',
    kind: 'tool',
    cost_source_slug: 'tavily-search',
    metric: 'credit',
    unit_cost_usd: '0.75',
  },
};

const transaction = {} as TransactionSql;
const pricingHash = 'a'.repeat(64);

describe('authoritative budget lifecycle exact pricing', () => {
  it('delegates LLM actual usage to the authoritative frozen-snapshot pricer', async () => {
    const pricer = vi.fn(async () => ({ available: true as const, cost_usd: '0.00012225' }));
    await expect(
      priceActualUsageFromFrozenPricing(transaction, llmContext, pricingHash, llmRequest(), pricer),
    ).resolves.toBe('0.00012225');
    expect(pricer).toHaveBeenCalledWith({
      tx: transaction,
      pricing_snapshot: llmContext.pricingSnapshot,
      pricing_snapshot_hash: pricingHash,
      usage: { kind: 'llm', input_tokens: 95, output_tokens: 180 },
      amount_kind: 'actual',
    });
  });

  it('delegates a volume-priced tool and preserves widened exact cost evidence', async () => {
    const context = {
      ...toolContext,
      pricingSnapshot: {
        ...toolContext.pricingSnapshot,
        pricing_model: 'volume',
        tiers: [{ from: '0', to: null, price_per_unit_usd: '999999.999999' }],
      },
    };
    const widenedActual = '99999999999899999999999999.999999999999';
    const pricer = vi.fn(async () => ({ available: true as const, cost_usd: widenedActual }));
    await expect(
      priceActualUsageFromFrozenPricing(
        transaction,
        context,
        pricingHash,
        toolRequest('99999999999999999999.999999999999999999'),
        pricer,
      ),
    ).resolves.toBe(widenedActual);
    expect(pricer).toHaveBeenCalledWith(
      expect.objectContaining({
        amount_kind: 'actual',
        pricing_snapshot: context.pricingSnapshot,
        usage: {
          kind: 'tool',
          value: '99999999999999999999.999999999999999999',
        },
      }),
    );
  });

  it('rejects pricing identity substitution and request-kind substitution before pricing', async () => {
    const pricer = vi.fn(async () => ({ available: true as const, cost_usd: '1' }));
    await expect(
      priceActualUsageFromFrozenPricing(
        transaction,
        {
          ...llmContext,
          pricingSnapshot: { ...llmContext.pricingSnapshot, model: 'substituted-model' },
        },
        pricingHash,
        llmRequest(),
        pricer,
      ),
    ).rejects.toThrow(/pricing identity/i);

    await expect(
      priceActualUsageFromFrozenPricing(
        transaction,
        toolContext,
        pricingHash,
        llmRequest(),
        pricer,
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'RESERVATION_STATE_CONFLICT',
        status: 409,
      }),
    );
    expect(pricer).not.toHaveBeenCalled();
  });

  it('fails closed with a typed 503 when frozen pricing cannot price actual usage', async () => {
    const pricer = vi.fn(async () => ({
      available: false as const,
      reason: 'pricing_unavailable' as const,
      cause: 'malformed' as const,
    }));
    await expect(
      priceActualUsageFromFrozenPricing(
        transaction,
        toolContext,
        pricingHash,
        toolRequest('2.5'),
        pricer,
      ),
    ).rejects.toMatchObject({
      name: 'BudgetLifecyclePricingUnavailableError',
      status: 503,
      code: 'INTERNAL_ERROR',
      cause: 'malformed',
    });
    await expect(
      priceActualUsageFromFrozenPricing(
        transaction,
        toolContext,
        pricingHash,
        toolRequest('2.5'),
        pricer,
      ),
    ).rejects.toBeInstanceOf(BudgetLifecyclePricingUnavailableError);
  });

  it.each([
    {
      label: 'below the hold',
      reserved: '1',
      actual: '0.6',
      released: '0.4',
      overage: '0',
    },
    {
      label: 'equal to the hold',
      reserved: '1.000000000000000000',
      actual: '1',
      released: '0',
      overage: '0',
    },
    {
      label: 'above the hold',
      reserved: '1',
      actual: '1.25',
      released: '0',
      overage: '0.25',
    },
  ])('calculates settlement $label exactly', ({ reserved, actual, released, overage }) => {
    expect(calculateBudgetSettlement(reserved, actual)).toEqual({
      reservedUsd: '1',
      actualUsd: actual,
      releasedUsd: released,
      overageUsd: overage,
    });
  });

  it('calculates widened actual and overage without narrowing to the reservation range', () => {
    expect(calculateBudgetSettlement('1', '99999999999899999999999999.999999999999')).toEqual({
      reservedUsd: '1',
      actualUsd: '99999999999899999999999999.999999999999',
      releasedUsd: '0',
      overageUsd: '99999999999899999999999998.999999999999',
    });
  });
});

describe('authoritative lifecycle replay and errors', () => {
  it.each([
    {
      label: 'the exact PostgreSQL error',
      error: {
        code: '55000',
        message: 'only a live reservation lease may be extended',
      },
      expected: true,
    },
    {
      label: 'the exact PostgreSQL error wrapped by a transport error',
      error: {
        cause: {
          code: '55000',
          message: 'only a live reservation lease may be extended',
        },
      },
      expected: true,
    },
    {
      label: 'an unrelated error with the same SQLSTATE',
      error: { code: '55000', message: 'another lifecycle invariant failed' },
      expected: false,
    },
    {
      label: 'a crossed error layer',
      error: {
        code: '23514',
        message: 'outer constraint error',
        cause: {
          code: '55000',
          message: 'only a live reservation lease may be extended',
        },
      },
      expected: false,
    },
  ])('classifies $label without broadening lifecycle retries', ({ error, expected }) => {
    expect(__budgetLifecycleTesting.isExtensionLeaseBoundaryDatabaseError(error)).toBe(expected);
  });

  it('locks every held allocation account in deterministic UUID order', async () => {
    let query = '';
    const lockTransaction = ((strings: TemplateStringsArray) => {
      query = strings.join('?');
      return Promise.resolve([{ id: '33333333-3333-4333-8333-333333333333' }]);
    }) as unknown as TransactionSql;
    await expect(
      __budgetLifecycleTesting.lockAllocationAccounts(
        lockTransaction,
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).resolves.toBe(1);
    expect(query).toMatch(/ORDER BY account\.id ASC\s+FOR UPDATE OF account/);
  });

  it('fails closed when a held reservation has no allocation accounts', async () => {
    const lockTransaction = (() => Promise.resolve([])) as unknown as TransactionSql;
    await expect(
      __budgetLifecycleTesting.lockAllocationAccounts(
        lockTransaction,
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
      ),
    ).rejects.toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
  });

  it('returns a cloned stored response with only replay truth changed', () => {
    const stored = {
      schema_version: '1.0',
      state: 'released',
      reservation_id: '33333333-3333-4333-8333-333333333333',
      operation_id: '11111111-1111-4111-8111-111111111111',
      released_usd: '1',
      released_at: '2026-07-14T00:00:00.000Z',
      idempotent_replay: false,
    };
    const replay = __budgetLifecycleTesting.replayResponse(stored);
    expect(replay).toEqual({ ...stored, idempotent_replay: true });
    expect(stored.idempotent_replay).toBe(false);
  });

  it('surfaces schema readiness as a typed 503 without losing the exact amount', () => {
    const error = new BudgetLifecycleSchemaBlockerError('100000000000000000000');
    expect(error).toBeInstanceOf(BudgetLifecycleError);
    expect(error).toMatchObject({
      status: 503,
      code: 'INTERNAL_ERROR',
      actualUsd: '100000000000000000000',
    });
  });

  it('queries widened schema readiness only when actual cost leaves NUMERIC(38,18)', async () => {
    const untouched = vi.fn();
    const narrowTransaction = untouched as unknown as TransactionSql;
    await expect(
      __budgetLifecycleTesting.assertRuntimeAmountCapacity(narrowTransaction, '1.25'),
    ).resolves.toBeUndefined();
    expect(untouched).not.toHaveBeenCalled();

    const readyTransaction = (() =>
      Promise.resolve([{ ready: true }])) as unknown as TransactionSql;
    await expect(
      __budgetLifecycleTesting.assertRuntimeAmountCapacity(
        readyTransaction,
        '100000000000000000000',
      ),
    ).resolves.toBeUndefined();
  });

  it('blocks widened actual cost before mutation when runtime columns are not ready', async () => {
    const oldSchemaTransaction = (() =>
      Promise.resolve([{ ready: false }])) as unknown as TransactionSql;
    await expect(
      __budgetLifecycleTesting.assertRuntimeAmountCapacity(
        oldSchemaTransaction,
        '100000000000000000000',
      ),
    ).rejects.toMatchObject({
      name: 'BudgetLifecycleSchemaBlockerError',
      status: 503,
      actualUsd: '100000000000000000000',
    });
  });

  it('treats a server-stamped terminal mutation at the exact lease boundary as late', () => {
    const expiresAt = new Date('2026-07-14T00:00:00.500Z');
    expect(
      __budgetLifecycleTesting.terminalTimestampAtOrAfterExpiry(
        '2026-07-14T00:00:00.499Z',
        expiresAt,
      ),
    ).toBe(false);
    expect(
      __budgetLifecycleTesting.terminalTimestampAtOrAfterExpiry(
        '2026-07-14T00:00:00.500Z',
        expiresAt,
      ),
    ).toBe(true);
    expect(
      __budgetLifecycleTesting.terminalTimestampAtOrAfterExpiry(
        '2026-07-14T00:00:00.501Z',
        expiresAt,
      ),
    ).toBe(true);
  });

  it('rejects malformed lifecycle instants instead of guessing lease order', () => {
    expect(() =>
      __budgetLifecycleTesting.terminalTimestampAtOrAfterExpiry(
        'not-a-timestamp',
        new Date('2026-07-14T00:00:00.000Z'),
      ),
    ).toThrow(/valid instant/i);
  });

  it.each([0, 1.5, 1_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe expiry batch limit %s',
    (limit) => {
      expect(() => __budgetLifecycleTesting.validateExpiryLimit(limit)).toThrow(RangeError);
    },
  );

  it.each([1, 100, 1_000])('accepts bounded expiry batch limit %i', (limit) => {
    expect(__budgetLifecycleTesting.validateExpiryLimit(limit)).toBe(limit);
  });

  it.each(['-1', '+1', '1e-6', '01', '1.1234567890123456789', 'NaN', 'Infinity'])(
    'rejects unsafe decimal form %s before ledger mutation',
    (value) => {
      expect(() => __budgetLifecycleTesting.decimalUnits(value, 'amount')).toThrow(
        /canonical nonnegative decimal/i,
      );
    },
  );
});
