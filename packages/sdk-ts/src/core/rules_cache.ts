// Rules cache. B1 ships as fetch + TTL + passthrough only — rule evaluation
// lands in B4-T1. The cache is exposed so abort.ts and the future rules engine
// can share the same fetch path.

import { getConfig } from './config.js';
import { registerIdentityResetter } from './identity_registry.js';
import { AuthenticatedRoute, coreRuntime } from '../internal/core-runtime-state.js';

// PR #70 follow-up — 60s per remaining-implementation-plan.md O25
// (was 300s; plan tightened to keep newly-activated rules reaching
// SDKs in &lt;1 min). Stale-serve semantics unchanged: on fetch error
// past TTL we keep the last successful rules array and flip
// passthrough=true so the engine fails open.
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
      if (!warnedPassthrough)
        console.warn('[pylva] rules cache stale — backend returned non-ok; passthrough mode');
      warnedPassthrough = true;
      state.passthrough = true;
      return;
    }
    const body = JSON.parse(res.bodyText) as { rules?: unknown[] };
    if (owner !== cacheEpoch) return;
    state = { rules: body.rules ?? [], fetchedAt: now, passthrough: false };
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
