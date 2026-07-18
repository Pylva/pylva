// Shared advisory-budget and catalog state. Backing cache and accumulator
// maps remain module-private.

export {
  add,
  check,
  get,
  initAccumulator,
  markExceededFromBackend,
  runSyncNow,
  setFromSync,
  startSyncLoop,
  stopSyncLoop,
} from '../core/budget_accumulator.js';
export {
  findApplicableBudgetRules,
  narrowRule,
  periodStartUtc,
  recordLlmSpend,
} from '../core/budget_rules.js';
export { ensurePricingCache, getPricing } from '../core/pricing_cache.js';
export { ensureRulesCache, getCachedRules, isPassthrough } from '../core/rules_cache.js';

export type * from '../core/budget_accumulator.js';
export type * from '../core/budget_rules.js';
export type * from '../core/pricing_cache.js';
export type * from '../core/rules_cache.js';
