import { describe, expect, it, vi } from 'vitest';
import {
  getBudgetExactBackfillAdapter,
  installBudgetExactBackfillAdapter,
  isBudgetExactBackfillAdapterConfigured,
  type BudgetExactBackfillAdapter,
} from '../../src/lib/budget-control/exact-backfill-adapter.js';

describe('process-start exact-backfill adapter registry', () => {
  it('starts fail-closed and accepts only one coherent adapter authority', () => {
    expect(getBudgetExactBackfillAdapter()).toBeNull();
    expect(isBudgetExactBackfillAdapterConfigured()).toBe(false);
    expect(() =>
      installBudgetExactBackfillAdapter({
        activate: vi.fn(),
      } as unknown as BudgetExactBackfillAdapter),
    ).toThrow('activate() and resolveOpening()');

    const adapter: BudgetExactBackfillAdapter = {
      activate: vi.fn(),
      resolveOpening: vi.fn(async () => '1.25'),
    };
    installBudgetExactBackfillAdapter(adapter);
    expect(getBudgetExactBackfillAdapter()).toBe(adapter);
    expect(isBudgetExactBackfillAdapterConfigured()).toBe(true);
    expect(() => installBudgetExactBackfillAdapter(adapter)).not.toThrow();
    expect(() =>
      installBudgetExactBackfillAdapter({ activate: vi.fn(), resolveOpening: vi.fn() }),
    ).toThrow('different exact-backfill adapter');
    expect(getBudgetExactBackfillAdapter()).toBe(adapter);
  });
});
