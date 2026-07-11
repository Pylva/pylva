// Global LLM pricing cache (D22). SDK calls GET /api/v1/pricing once on init
// and every 24h after. Used by abort.ts to compute abort_savings_usd without
// a network round-trip.

import { getConfig } from './config.js';

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

function key(provider: string, model: string): string {
  return `${provider}|${model}`;
}

export async function ensurePricingCache(): Promise<void> {
  if (Date.now() < expiresAt) return;
  if (inFlight) return inFlight;
  inFlight = refresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function refresh(): Promise<void> {
  const cfg = getConfig();
  if (!cfg) return;
  try {
    const res = await fetch(`${cfg.endpoint}/api/v1/pricing`, {
      method: 'GET',
      headers: { 'X-Pylva-Key': cfg.apiKey },
    });
    if (!res.ok) {
      // Keep stale cache on outage; D22 says overgenerous TTL is fine.
      return;
    }
    const body = (await res.json()) as {
      models?: Array<PricingCacheEntry & { effective_to?: string | null }>;
    };
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
  }
}

export function getPricing(provider: string, model: string): PricingCacheEntry | undefined {
  return cache.get(key(provider, model));
}

export function _resetPricingCacheForTests(): void {
  cache = new Map();
  expiresAt = 0;
  inFlight = null;
}
