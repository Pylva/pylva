import type { ExactOpeningBalanceInput } from './accounts.js';
import type { ExactBackfillActivationInput } from './readiness.js';

/**
 * Production seam for an operator-owned, durable exact-backfill authority.
 *
 * `activate` runs under the exclusive builder transaction before readiness is
 * committed. It must install a retry-safe traffic fence/reconciliation
 * watermark using only transaction-scoped durable writes. `resolveOpening`
 * runs later under the same exclusive lock for every pooled or per-customer
 * first use and must read that durable reconciled state. Missing data must
 * throw; absence must never be interpreted as zero.
 */
export interface BudgetExactBackfillAdapter {
  activate(input: ExactBackfillActivationInput): void | Promise<void>;
  resolveOpening(input: ExactOpeningBalanceInput): string | Promise<string>;
}

interface BudgetExactBackfillAdapterRegistry {
  adapter: BudgetExactBackfillAdapter | null;
}

const REGISTRY_KEY = Symbol.for('pylva.budget-control.exact-backfill-adapter.v1');

function registry(): BudgetExactBackfillAdapterRegistry {
  const root = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: BudgetExactBackfillAdapterRegistry;
  };
  root[REGISTRY_KEY] ??= { adapter: null };
  return root[REGISTRY_KEY];
}

function assertAdapter(adapter: BudgetExactBackfillAdapter): void {
  if (
    typeof adapter !== 'object' ||
    adapter === null ||
    typeof adapter.activate !== 'function' ||
    typeof adapter.resolveOpening !== 'function'
  ) {
    throw new TypeError(
      'exact-backfill adapter must provide activate() and resolveOpening() functions',
    );
  }
}

/**
 * Installs the process-start adapter once. Reinstalling the same object is
 * idempotent; replacing it in a live process is rejected so capability and
 * materialization cannot observe different authorities.
 */
export function installBudgetExactBackfillAdapter(adapter: BudgetExactBackfillAdapter): void {
  assertAdapter(adapter);
  const state = registry();
  if (state.adapter !== null && state.adapter !== adapter) {
    throw new Error('a different exact-backfill adapter is already installed in this process');
  }
  state.adapter = adapter;
}

export function getBudgetExactBackfillAdapter(): BudgetExactBackfillAdapter | null {
  return registry().adapter;
}

export function isBudgetExactBackfillAdapterConfigured(): boolean {
  return getBudgetExactBackfillAdapter() !== null;
}
