// Rules cache. B1 ships as fetch + TTL + passthrough only — rule evaluation
// lands in B4-T1. The cache is exposed so abort.ts and the future rules engine
// can share the same fetch path.

import { getConfig } from './config.js';
import { registerIdentityResetter } from './identity_registry.js';
import { AuthenticatedRoute, coreRuntime } from '../internal/core-runtime-state.js';

// PR #70 follow-up — 60s per remaining-implementation-plan.md O25
// (was 300s; plan tightened to keep newly-activated rules reaching
// SDKs in &lt;1 min). A failed refresh may retain the last successful
// array for diagnostics/recovery, but passthrough=true prevents that stale
// snapshot from affecting routing, failover, or budget decisions.
const RULES_CACHE_TTL_MS = 60 * 1000;

interface RulesCacheState {
  rules: unknown[];
  fetchedAt: number;
  passthrough: boolean;
}

let state: RulesCacheState = { rules: [], fetchedAt: 0, passthrough: false };
let inFlight: Promise<void> | null = null;
let warnedPassthrough = false;
let cacheEpoch = 0;
const activeControllers = new Set<AbortController>();

export async function ensureRulesCache(): Promise<void> {
  const now = Date.now();
  const age = now - state.fetchedAt;
  if (age < RULES_CACHE_TTL_MS && !state.passthrough) return;
  // Never evaluate an expired snapshot while its refresh is in flight. The
  // wrapper intentionally does not await this refresh, so this assignment
  // must happen before refresh() reaches its first await.
  if (age >= RULES_CACHE_TTL_MS) state.passthrough = true;
  if (inFlight) return inFlight;
  const owner = cacheEpoch;
  const promise = refresh(now, age, owner);
  const wrapped = promise.finally(() => {
    if (inFlight === wrapped) inFlight = null;
  });
  inFlight = wrapped;
  return inFlight;
}

async function refresh(now: number, age: number, owner: number): Promise<void> {
  if (!getConfig()) return;
  const controller = new AbortController();
  activeControllers.add(controller);

  try {
    const res = await coreRuntime.authenticatedRequest({
      route: AuthenticatedRoute.RULES,
      signal: controller.signal,
    });
    if (owner !== cacheEpoch) return;
    if (!res.ok) {
      // Authentication/authorization failures are definitive for the current
      // SDK identity. A suspended workspace must not keep applying routing or
      // failover rules that were warmed while it was active.
      if (res.status === 401 || res.status === 403) {
        state.rules = [];
      }
      if (!warnedPassthrough)
        console.warn('[pylva] rules cache stale — backend returned non-ok; passthrough mode');
      warnedPassthrough = true;
      state.passthrough = true;
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(res.bodyText) as unknown;
    } catch {
      if (owner !== cacheEpoch) return;
      if (!warnedPassthrough) {
        console.warn(
          '[pylva] rules cache stale — backend returned malformed rules; passthrough mode',
        );
      }
      warnedPassthrough = true;
      state.passthrough = true;
      return;
    }
    if (owner !== cacheEpoch) return;
    const rules =
      typeof body === 'object' && body !== null ? (body as { rules?: unknown }).rules : undefined;
    if (!Array.isArray(rules)) {
      if (!warnedPassthrough) {
        console.warn(
          '[pylva] rules cache stale — backend returned malformed rules; passthrough mode',
        );
      }
      warnedPassthrough = true;
      state.passthrough = true;
      return;
    }
    state = { rules, fetchedAt: now, passthrough: false };
    warnedPassthrough = false;
  } catch {
    if (owner !== cacheEpoch) return;
    if (age > RULES_CACHE_TTL_MS && !warnedPassthrough) {
      console.warn('[pylva] rules cache stale — passthrough mode (backend unreachable > 60s)');
      warnedPassthrough = true;
    }
    state.passthrough = true;
  } finally {
    activeControllers.delete(controller);
  }
}

export function isPassthrough(): boolean {
  return state.passthrough;
}

export function getCachedRules(): unknown[] {
  return state.rules;
}

/**
 * Rules that may affect a provider call right now. Degraded/restricted cache
 * states retain transient stale data only for a future successful refresh;
 * they never expose it to routing, failover, or budget evaluation.
 */
export function getRulesForEvaluation(): unknown[] {
  const stale = Date.now() - state.fetchedAt >= RULES_CACHE_TTL_MS;
  return state.passthrough || stale ? [] : state.rules;
}

export function _resetRulesCacheForTests(): void {
  resetRulesCache();
}

function resetRulesCache(): void {
  cacheEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  state = { rules: [], fetchedAt: 0, passthrough: false };
  inFlight = null;
  warnedPassthrough = false;
}

export function _resetRulesCacheForIdentityChange(): void {
  resetRulesCache();
}

registerIdentityResetter(_resetRulesCacheForIdentityChange);
