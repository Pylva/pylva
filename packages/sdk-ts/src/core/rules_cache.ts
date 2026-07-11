// Rules cache. B1 ships as fetch + TTL + passthrough only — rule evaluation
// lands in B4-T1. The cache is exposed so abort.ts and the future rules engine
// can share the same fetch path.

import { getConfig } from './config.js';

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

export async function ensureRulesCache(): Promise<void> {
  const now = Date.now();
  const age = now - state.fetchedAt;
  if (age < RULES_CACHE_TTL_MS && !state.passthrough) return;
  if (inFlight) return inFlight;
  inFlight = refresh(now, age).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function refresh(now: number, age: number): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;

  try {
    const res = await fetch(`${cfg.endpoint}/api/v1/rules`, {
      method: 'GET',
      headers: { 'X-Pylva-Key': cfg.apiKey },
    });
    if (!res.ok) {
      if (!warnedPassthrough)
        console.warn('[pylva] rules cache stale — backend returned non-ok; passthrough mode');
      warnedPassthrough = true;
      state.passthrough = true;
      return;
    }
    const body = (await res.json()) as { rules?: unknown[] };
    state = { rules: body.rules ?? [], fetchedAt: now, passthrough: false };
    warnedPassthrough = false;
  } catch {
    if (age > RULES_CACHE_TTL_MS && !warnedPassthrough) {
      console.warn('[pylva] rules cache stale — passthrough mode (backend unreachable > 60s)');
      warnedPassthrough = true;
    }
    state.passthrough = true;
  }
}

export function isPassthrough(): boolean {
  return state.passthrough;
}

export function getCachedRules(): unknown[] {
  return state.rules;
}

export function _resetRulesCacheForTests(): void {
  state = { rules: [], fetchedAt: 0, passthrough: false };
  inFlight = null;
  warnedPassthrough = false;
}
