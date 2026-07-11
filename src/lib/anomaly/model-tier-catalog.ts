// Builds the `ModelTierCatalog` the recommendation engine consumes.
// Loads the currently effective row per (provider, model) from
// llm_pricing and tags each with a tier so the recommender can step
// down (flagship → standard → mini).
//
// Tier classification is heuristic by model-name pattern. The
// llm_pricing table doesn't carry a tier column today; the heuristic
// covers the providers shipped to date (openai, anthropic, google,
// deepseek, mistral, cohere). Unknown patterns fall back to ModelTier.UNKNOWN,
// which the recommender treats as "no downgrade available."

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ModelTier, type ModelTierCatalog, type ModelTierEntry } from '../rules/recommendations.js';

interface PricingRow extends Record<string, unknown> {
  provider: string;
  model: string;
  input_per_1m: string;
  output_per_1m: string;
}

export function classifyModelTier(provider: string, model: string): ModelTier {
  const m = model.toLowerCase();
  // Mini / nano patterns first — substring match would otherwise tag
  // 'gpt-4o-mini' as flagship via 'gpt-4o'.
  if (/(mini|nano|haiku|small|flash|tiny|8b|7b)/.test(m)) return ModelTier.MINI;
  if (/(sonnet|standard|medium|gpt-3\.5|turbo|34b|70b)/.test(m)) return ModelTier.STANDARD;
  if (/(opus|gpt-4o|gpt-4|gemini-.*pro|command-r-plus|large)/.test(m)) return ModelTier.FLAGSHIP;
  // Provider-specific defaults for models that don't match the patterns.
  if (provider === 'openai' && m.startsWith('o1')) return ModelTier.FLAGSHIP;
  return ModelTier.UNKNOWN;
}

/**
 * Loads the currently effective llm_pricing row per (provider, model)
 * and builds the catalog the recommender keys into. Uses DISTINCT ON to
 * pick the most recent effective_from per key.
 */
export async function loadModelTierCatalog(now: Date = new Date()): Promise<ModelTierCatalog> {
  // Bind the ISO string, not the Date: drizzle's raw db.execute goes through
  // postgres.js unsafe(), which rejects Date params outright ("argument must
  // be of type string or Buffer") — this crashed the entire detect-anomalies
  // run at catalog load. Postgres casts ISO-8601 text to timestamptz.
  const nowIso = now.toISOString();
  const rows = await db.execute<PricingRow>(sql`
    SELECT DISTINCT ON (provider, model)
      provider,
      model,
      input_per_1m,
      output_per_1m
    FROM llm_pricing
    WHERE effective_from <= ${nowIso}
      AND (effective_to IS NULL OR effective_to > ${nowIso})
    ORDER BY provider, model, effective_from DESC
  `);

  const byProviderModel = new Map<string, ModelTierEntry>();
  for (const r of rows) {
    const tier = classifyModelTier(r.provider, r.model);
    byProviderModel.set(`${r.provider}|${r.model}`, {
      provider: r.provider,
      model: r.model,
      tier,
      input_per_1m_usd: Number(r.input_per_1m),
      output_per_1m_usd: Number(r.output_per_1m),
    });
  }
  return { byProviderModel };
}
