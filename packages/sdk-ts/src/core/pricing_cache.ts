// Global LLM pricing cache (D22). SDK calls GET /api/v1/pricing once on init
// and every 24h after. Used by abort.ts to compute abort_savings_usd without
// a network round-trip.

import { getConfig } from './config.js';
import { registerIdentityResetter } from './identity_registry.js';
import { AuthenticatedRoute, coreRuntime } from '../internal/core-runtime-state.js';

export interface PricingCacheEntry {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

let cache: Map<string, PricingCacheEntry> = new Map();
let expiresAt = 0;
let inFlight: Promise<void> | null = null;
let cacheEpoch = 0;
const activeControllers = new Set<AbortController>();

function key(provider: string, model: string): string {
  return `${provider}|${model}`;
}

export async function ensurePricingCache(): Promise<void> {
  if (Date.now() < expiresAt) return;
  if (inFlight) return inFlight;
  const owner = cacheEpoch;
  const promise = refresh(owner);
  const wrapped = promise.finally(() => {
    if (inFlight === wrapped) inFlight = null;
  });
  inFlight = wrapped;
  return inFlight;
}

async function refresh(owner: number): Promise<void> {
  if (!getConfig()) return;
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    const res = await coreRuntime.authenticatedRequest({
      route: AuthenticatedRoute.PRICING,
      signal: controller.signal,
    });
    if (owner !== cacheEpoch) return;
    if (!res.ok) {
      // Keep stale cache on outage; D22 says overgenerous TTL is fine.
      return;
    }
    const body = JSON.parse(res.bodyText) as {
      models?: Array<PricingCacheEntry & { effective_to?: string | null }>;
    };
    if (owner !== cacheEpoch) return;
    const next = new Map<string, PricingCacheEntry>();
    for (const m of body.models ?? []) {
      next.set(key(m.provider, m.model), {
        provider: m.provider,
        model: m.model,
        input_per_1m: Number(m.input_per_1m),
        output_per_1m: Number(m.output_per_1m),
      });
    }
    cache = next;
    expiresAt = Date.now() + TWENTY_FOUR_HOURS_MS;
  } catch {
    // Network error — keep stale cache.
  } finally {
    activeControllers.delete(controller);
  }
}

export function getPricing(provider: string, model: string): PricingCacheEntry | undefined {
  return cache.get(key(provider, model));
}

export function _resetPricingCacheForTests(): void {
  resetPricingCache();
}

function resetPricingCache(): void {
  cacheEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  cache = new Map();
  expiresAt = 0;
  inFlight = null;
}

export function _resetPricingCacheForIdentityChange(): void {
  resetPricingCache();
}

registerIdentityResetter(_resetPricingCacheForIdentityChange);
