// Shared legacy routing/failover and provider-registry state. Budget catalog
// state is imported from the canonical budget runtime.

export { evaluatePreCall, narrowRules } from '../core/rules_engine.js';
export { attemptWithFallback, shouldFallback } from '../core/model_routing.js';
export { ensureState, isActive, recordOutcome, selectProvider } from '../core/failover.js';
export {
  getRegisteredClient,
  hasRegisteredClient,
  registerProviderClient,
  registerProviderClients,
} from '../core/client_registry.js';

export type * from '../core/rules_engine.js';
export type * from '../core/model_routing.js';
export type * from '../core/failover.js';
export type * from '../core/client_registry.js';
