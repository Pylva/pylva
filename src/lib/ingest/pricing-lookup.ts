// Batched pricing lookup for ingest (B1 — §7.2 Risk #3 mitigation).
// Collects every unique (provider, model) and (metric) referenced in a batch,
// resolves them in at most 3 SQL queries (custom LLM + global LLM + custom metric),
// then feeds calculateCostUsd() via the PricingMap.
//
// All queries are parameterized via Drizzle's sql`` tagged templates — values
// are sent as bind parameters. We never interpolate user-provided strings
// into the SQL text.
//
// Caching: in-process LRU keyed per-builder for custom rows and shared for
// llm_pricing rows, 5-min TTL. Each cache entry contains the complete version
// chain for its key so a later batch with older timestamps cannot fall through
// from a historical custom override to the global catalog price.

import { type TelemetryEvent, InstrumentationTier } from '@pylva/shared';
import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import { withRLS } from '../db/rls.js';
import { unwrapRows } from '../db/query-utils.js';
import {
  emptyPricingMap,
  type LlmPriceRow,
  type MetricPriceRow,
  llmKey,
  metricKey,
  type PricingMap,
} from '../cost-calculator.js';
import { resolveCostSourcePricing } from './cost-source-pricing.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'ingest.pricing-lookup' });

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

const llmCache = new Map<string, CacheEntry<LlmPriceRow[]>>();
const customLlmCache = new Map<string, CacheEntry<LlmPriceRow[]>>();
const customMetricCache = new Map<string, CacheEntry<MetricPriceRow[]>>();

function readCache<V>(m: Map<string, CacheEntry<V>>, key: string): V | undefined {
  const entry = m.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    m.delete(key);
    return undefined;
  }
  return entry.value;
}

function writeCache<V>(m: Map<string, CacheEntry<V>>, key: string, value: V): void {
  m.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function sqlStringList(values: string[]): SQL {
  return drizzleSql.join(
    values.map((value) => drizzleSql`${value}`),
    drizzleSql.raw(', '),
  );
}

function sqlLlmPairList(pairs: Array<{ provider: string; model: string }>): SQL {
  return drizzleSql.join(
    pairs.map((pair) => drizzleSql`(${pair.provider}, ${pair.model})`),
    drizzleSql.raw(', '),
  );
}

export function resetPricingCaches(): void {
  llmCache.clear();
  customLlmCache.clear();
  customMetricCache.clear();
}

/**
 * Resolve every unique (provider, model) and (metric) touched by this batch.
 * Returns a PricingMap ready for calculateCostUsd() — custom_pricing rows take
 * precedence over llm_pricing when both match.
 */
export async function lookupPricing(
  builderId: string,
  events: TelemetryEvent[],
): Promise<PricingMap> {
  const map = emptyPricingMap();
  if (events.length === 0) return map;

  const llmPairs = new Set<string>(); // `provider|model`
  const metricNames = new Set<string>();

  for (const ev of events) {
    if (ev.instrumentation_tier === InstrumentationTier.SDK_WRAPPER && ev.provider && ev.model) {
      llmPairs.add(`${ev.provider}|${ev.model}`);
    } else if (ev.instrumentation_tier === InstrumentationTier.REPORTED && ev.metric) {
      metricNames.add(ev.metric);
    }
  }

  if (llmPairs.size === 0 && metricNames.size === 0) return map;

  // --- Serve everything we can from cache ---
  const uncachedLlmPairs: Array<{ provider: string; model: string }> = [];
  for (const pair of llmPairs) {
    const [provider, model] = pair.split('|') as [string, string];
    const key = llmKey(provider, model);
    const cachedCustom = readCache(customLlmCache, `${builderId}:${key}`);
    const cachedGlobal = readCache(llmCache, key);
    if (cachedCustom !== undefined && cachedGlobal !== undefined) {
      map.llm.set(key, [...cachedCustom, ...cachedGlobal]);
      continue;
    }
    uncachedLlmPairs.push({ provider, model });
  }

  const uncachedMetricNames: string[] = [];
  for (const metric of metricNames) {
    const cached = readCache(customMetricCache, `${builderId}:${metric}`);
    if (cached !== undefined) {
      map.metric.set(metricKey(metric), cached);
      continue;
    }
    uncachedMetricNames.push(metric);
  }

  const resolveCostSourceFallbacks = async (): Promise<void> => {
    // Track 2 PR 2.4 (O17): cost_sources fallback for any REPORTED metric
    // that didn't match custom_pricing. 60s in-process cache lives in
    // cost-source-pricing.ts. D9 future-only semantics keep this safe.
    // v1.1 follow-up: tiered cost_sources rows now flow through —
    // cost-calculator walks tiers when present.
    for (const metric of metricNames) {
      const k = metricKey(metric);
      // A metric resolved from custom_pricing always seeds map.metric — but a
      // *miss* seeds an empty array too (the cache-hit branch above does the
      // same). Gate on a NON-EMPTY entry, not mere presence: has(k) is true even
      // for the empty-array miss, which silently skipped this fallback for every
      // cost_sources-priced metric (cost_usd -> null -> needs_input -> unbilled).
      if ((map.metric.get(k)?.length ?? 0) > 0) continue;
      const result = await resolveCostSourcePricing(builderId, metric);
      if (result.pricePerUnit !== null) {
        map.metric.set(k, [
          {
            metric,
            price_per_unit_usd: result.pricePerUnit,
            effective_from: new Date(0),
            effective_to: null,
            source: 'cost_sources',
          },
        ]);
      } else if (result.tiers !== null) {
        map.metric.set(k, [
          {
            metric,
            price_per_unit_usd: 0, // unused when tiers present
            tiers: result.tiers,
            effective_from: new Date(0),
            effective_to: null,
            source: 'cost_sources',
          },
        ]);
      }
    }
  };

  if (uncachedLlmPairs.length === 0 && uncachedMetricNames.length === 0) {
    await resolveCostSourceFallbacks();
    return map;
  }

  try {
    await withRLS(builderId, async (tx) => {
      if (uncachedLlmPairs.length > 0) {
        const pairList = sqlLlmPairList(uncachedLlmPairs);

        // custom_pricing (builder-scoped) + llm_pricing (global) are
        // independent reads inside the same transaction — fan out.
        const [customResult, globalResult] = await Promise.all([
          tx.execute<{
            provider: string;
            model: string;
            price_per_unit_usd: string | null;
            input_per_1m_usd: string | null;
            output_per_1m_usd: string | null;
            effective_from: Date;
            effective_to: Date | null;
          }>(drizzleSql`
            SELECT provider, model,
                   price_per_unit_usd::text AS price_per_unit_usd,
                   input_per_1m_usd::text AS input_per_1m_usd,
                   output_per_1m_usd::text AS output_per_1m_usd,
                   effective_from, effective_to
            FROM custom_pricing
            WHERE builder_id = ${builderId}
              AND (provider, model) IN (${pairList})
          `),
          tx.execute<{
            provider: string;
            model: string;
            input_per_1m_usd: string | null;
            output_per_1m_usd: string | null;
            effective_from: Date;
            effective_to: Date | null;
          }>(drizzleSql`
            SELECT provider, model,
                   input_per_1m::text AS input_per_1m_usd,
                   output_per_1m::text AS output_per_1m_usd,
                   effective_from, effective_to
            FROM llm_pricing
            WHERE (provider, model) IN (${pairList})
          `),
        ]);
        const customRows = unwrapRows<{
          provider: string;
          model: string;
          price_per_unit_usd: string | null;
          input_per_1m_usd: string | null;
          output_per_1m_usd: string | null;
          effective_from: Date | string;
          effective_to: Date | string | null;
        }>(customResult);
        const globalRows = unwrapRows<{
          provider: string;
          model: string;
          input_per_1m_usd: string | null;
          output_per_1m_usd: string | null;
          effective_from: Date | string;
          effective_to: Date | string | null;
        }>(globalResult);

        for (const pair of uncachedLlmPairs) {
          const key = llmKey(pair.provider, pair.model);
          const customs: LlmPriceRow[] = customRows
            .filter((r) => r.provider === pair.provider && r.model === pair.model)
            .map((r) => ({
              provider: pair.provider,
              model: pair.model,
              input_per_1m_usd:
                r.input_per_1m_usd != null
                  ? Number(r.input_per_1m_usd)
                  : r.price_per_unit_usd != null
                    ? Number(r.price_per_unit_usd) * 1_000_000
                    : 0,
              output_per_1m_usd:
                r.output_per_1m_usd != null
                  ? Number(r.output_per_1m_usd)
                  : r.price_per_unit_usd != null
                    ? Number(r.price_per_unit_usd) * 1_000_000
                    : 0,
              effective_from: new Date(r.effective_from),
              effective_to: r.effective_to ? new Date(r.effective_to) : null,
              source: 'custom_pricing',
            }));

          const globals: LlmPriceRow[] = globalRows
            .filter((r) => r.provider === pair.provider && r.model === pair.model)
            .map((r) => ({
              provider: pair.provider,
              model: pair.model,
              input_per_1m_usd: Number(r.input_per_1m_usd ?? 0),
              output_per_1m_usd: Number(r.output_per_1m_usd ?? 0),
              effective_from: new Date(r.effective_from),
              effective_to: r.effective_to ? new Date(r.effective_to) : null,
              source: 'llm_pricing',
            }));

          writeCache(customLlmCache, `${builderId}:${key}`, customs);
          writeCache(llmCache, key, globals);
          map.llm.set(key, [...customs, ...globals]);
        }
      }

      if (uncachedMetricNames.length > 0) {
        const metricList = sqlStringList(uncachedMetricNames);
        const metricResult = await tx.execute<{
          metric: string;
          price_per_unit_usd: string;
          effective_from: Date | string;
          effective_to: Date | string | null;
        }>(drizzleSql`
          SELECT metric,
                 price_per_unit_usd::text AS price_per_unit_usd,
                 effective_from, effective_to
          FROM custom_pricing
          WHERE builder_id = ${builderId}
            AND metric IN (${metricList})
        `);
        const metricRows = unwrapRows<{
          metric: string;
          price_per_unit_usd: string;
          effective_from: Date | string;
          effective_to: Date | string | null;
        }>(metricResult);

        for (const metric of uncachedMetricNames) {
          const rows: MetricPriceRow[] = metricRows
            .filter((r) => r.metric === metric)
            .map((r) => ({
              metric,
              price_per_unit_usd: Number(r.price_per_unit_usd),
              effective_from: new Date(r.effective_from),
              effective_to: r.effective_to ? new Date(r.effective_to) : null,
              source: 'custom_pricing',
            }));
          writeCache(customMetricCache, `${builderId}:${metric}`, rows);
          map.metric.set(metricKey(metric), rows);
        }
      }
    });
  } catch (err) {
    log.error(
      { builder_id: builderId, error: err instanceof Error ? err.message : String(err) },
      'pricing lookup failed; all events in batch will mark as needs_input',
    );
  }

  await resolveCostSourceFallbacks();

  return map;
}
