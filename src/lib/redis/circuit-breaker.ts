// Circuit breakers for Redis — Decision #9: opossum
// Three instances with per-use-case thresholds
// Must be module-level singletons (not per-request)

import CircuitBreaker from 'opossum';

// Generic Redis call wrapper
type RedisCallFn = (...args: unknown[]) => Promise<unknown>;

// --- Rate Limit Breaker ---
export const rateLimitBreaker = new CircuitBreaker(
  async (fn: RedisCallFn, ...args: unknown[]) => fn(...args),
  {
    timeout: 500, // 500ms timeout
    errorThresholdPercentage: 50,
    resetTimeout: 10000, // 10s before half-open
    name: 'rate-limit',
    volumeThreshold: 5,
  },
);

// Fail-open: allow request when circuit is open
rateLimitBreaker.fallback(() => {
  console.warn('[circuit-breaker:rate-limit] OPEN — allowing request (fail-open)');
  return null;
});

// --- Revocation Breaker ---
export const revocationBreaker = new CircuitBreaker(
  async (fn: RedisCallFn, ...args: unknown[]) => fn(...args),
  {
    timeout: 200, // 200ms — revocation checks must be fast
    errorThresholdPercentage: 50,
    resetTimeout: 5000, // 5s — check more aggressively
    name: 'revocation',
    volumeThreshold: 5,
  },
);

// Fail-open: allow request per spec
revocationBreaker.fallback(() => {
  console.warn('[circuit-breaker:revocation] OPEN — allowing request (fail-open)');
  return null;
});

// --- Cache Breaker ---
export const cacheBreaker = new CircuitBreaker(
  async (fn: RedisCallFn, ...args: unknown[]) => fn(...args),
  {
    timeout: 300,
    errorThresholdPercentage: 50,
    resetTimeout: 15000, // 15s — cache is less critical
    name: 'cache',
    volumeThreshold: 5,
  },
);

// Fail-open: extend local cache TTL
cacheBreaker.fallback(() => {
  console.warn('[circuit-breaker:cache] OPEN — extending local cache TTL (fail-open)');
  return null;
});

// --- Health check helper ---

export interface CircuitBreakerState {
  name: string;
  state: 'closed' | 'open' | 'half-open';
}

export function getCircuitBreakerStates(): CircuitBreakerState[] {
  return [rateLimitBreaker, revocationBreaker, cacheBreaker].map((cb) => ({
    name: cb.name,
    state: cb.opened ? 'open' : cb.halfOpen ? 'half-open' : 'closed',
  }));
}
