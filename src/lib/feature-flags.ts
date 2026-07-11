// Track 3 PR 3.1 — feature flag resolver.
// Per internal design notes (O29).
//
// Resolution: env default OR per-builder override (override wins).
// Override rows live in `feature_flag_overrides` (migration 032).

import { and, eq } from 'drizzle-orm';
import { withRLS } from './db/rls.js';
import { featureFlagOverrides } from './db/schema.js';
import { env } from './config.js';

export type FeatureFlag =
  | 'ENABLE_SIMULATOR'
  | 'ENABLE_SSE_FEED'
  | 'ENABLE_COST_SOURCES'
  | 'ENABLE_ADVANCED_RULES'
  | 'ENABLE_PORTAL';

function envDefault(flag: FeatureFlag): boolean {
  switch (flag) {
    case 'ENABLE_SIMULATOR':
      return env.ENABLE_SIMULATOR;
    case 'ENABLE_SSE_FEED':
      return env.ENABLE_SSE_FEED;
    case 'ENABLE_COST_SOURCES':
      return env.ENABLE_COST_SOURCES;
    case 'ENABLE_ADVANCED_RULES':
      return env.ENABLE_ADVANCED_RULES;
    case 'ENABLE_PORTAL':
      return env.ENABLE_PORTAL;
  }
}

const cache = new Map<string, { enabled: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export function resetFeatureFlagCache(): void {
  cache.clear();
}

/**
 * Resolve a feature flag for a builder. Returns the per-builder override
 * if set; otherwise the env default. Cached for 60s per (builder, flag).
 */
export async function isFeatureEnabled(builderId: string, flag: FeatureFlag): Promise<boolean> {
  const key = `${builderId}:${flag}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;

  let enabled = envDefault(flag);
  try {
    const rows = await withRLS(builderId, async (tx) =>
      tx
        .select({ enabled: featureFlagOverrides.enabled })
        .from(featureFlagOverrides)
        .where(
          and(
            eq(featureFlagOverrides.builder_id, builderId),
            eq(featureFlagOverrides.flag_name, flag),
          ),
        )
        .limit(1),
    );
    if (rows.length > 0) enabled = rows[0]!.enabled;
  } catch {
    // DB hiccup — fall through to env default. Better to fail-open on
    // observability features than to lock builders out of their dashboard.
  }

  cache.set(key, { enabled, expiresAt: Date.now() + CACHE_TTL_MS });
  return enabled;
}
