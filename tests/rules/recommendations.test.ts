// B4-4a — pure-function tests for the recommendation engine. Builds
// in-memory model-tier catalogs + diagnoses; no DB access.

import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  AnomalyRecommendationAction,
  DEFAULT_MODEL_ROUTING_FALLBACK,
  DriverKind,
  type AnomalyDiagnosis,
  type ModelRoutingFallback,
} from '@pylva/shared';
import { ruleCreateSchema } from '../../src/lib/rules/validator.js';
import {
  ModelTier,
  recommendFromDiagnosis,
  type ModelTierCatalog,
  type ModelTierEntry,
  type RecommendationContext,
} from '../../src/lib/rules/recommendations.js';

function entry(
  provider: string,
  model: string,
  tier: ModelTier,
  costIn: number,
  costOut: number,
): ModelTierEntry {
  return {
    provider,
    model,
    tier,
    input_per_1m_usd: costIn,
    output_per_1m_usd: costOut,
  };
}

function catalog(...entries: ModelTierEntry[]): ModelTierCatalog {
  const map = new Map<string, ModelTierEntry>();
  for (const e of entries) map.set(`${e.provider}|${e.model}`, e);
  return { byProviderModel: map };
}

function ctx(
  c: ModelTierCatalog,
  overrides: Partial<RecommendationContext> = {},
): RecommendationContext {
  return {
    catalog: c,
    customer_id: 'cust_1',
    ...overrides,
  };
}

function modelDriver(
  provider: string,
  model: string,
  delta_usd: number,
): AnomalyDiagnosis['top_drivers'] extends Array<infer U> | undefined ? U : never {
  return {
    kind: DriverKind.MODEL,
    label: `${provider}/${model}`,
    provider,
    model,
    delta_usd,
  };
}

describe('recommendFromDiagnosis — empty diagnosis', () => {
  it('returns DISMISS when diagnosis has no signal', () => {
    const out = recommendFromDiagnosis({}, ctx(catalog()));
    expect(out.action).toBe(AnomalyRecommendationAction.DISMISS);
  });

  it('returns INVESTIGATE_DEEP_LINK when only insufficient_revenue_data is set (bug_009)', () => {
    // Today the runner hardcodes `has_revenue_data: false`, so every
    // diagnosis the cron produces has this flag. If the recommender
    // dismissed on this alone, the runner's empty-diagnosis short-
    // circuit would silently drop every detector hit without
    // surfacing anything. The flag must count as content.
    const out = recommendFromDiagnosis({ insufficient_revenue_data: true }, ctx(catalog()));
    expect(out.action).toBe(AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK);
  });
});

describe('recommendFromDiagnosis — model-driver path', () => {
  it('emits CREATE_DRAFT_MODEL_ROUTING_RULE with downgrade target', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.action).toBe(AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE);
    expect(out.draft_rule).toBeDefined();
    expect(out.draft_rule?.route_to).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(out.draft_rule?.match).toEqual({
      customer_id: 'cust_1',
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(out.projected_savings_usd).toBeGreaterThan(0);
    expect(out.ab_suggestion?.traffic_pct).toBe(10);
    // bug_001: recommender no longer stamps deep_link_url. The
    // dispatcher constructs it from the persisted anomaly id at
    // alert-fire time.
    expect(out.deep_link_url).toBeUndefined();
  });

  it('uses fallback defaults from RecommendationContext when provided', () => {
    const customFallback: ModelRoutingFallback = {
      ...DEFAULT_MODEL_ROUTING_FALLBACK,
      on_access_denied: false,
    };
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c, { fallback: customFallback }));
    expect(out.draft_rule?.fallback.on_access_denied).toBe(false);
  });

  it('uses DEFAULT_MODEL_ROUTING_FALLBACK when no override provided', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.draft_rule?.fallback).toEqual(DEFAULT_MODEL_ROUTING_FALLBACK);
  });

  it('respects ab_suggestion_traffic_pct override', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c, { ab_suggestion_traffic_pct: 25 }));
    expect(out.ab_suggestion?.traffic_pct).toBe(25);
    expect(out.ab_suggestion?.rationale).toContain('25%');
  });

  it('uses pooled scope and omits match.customer_id when customer_id is null', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c, { customer_id: null }));
    expect(out.draft_rule?.scope).toBe('pooled');
    expect(out.draft_rule?.match.customer_id).toBeUndefined();
  });

  it('handles slash-bearing model names without label parsing', () => {
    const c = catalog(
      entry('together_ai', 'meta-llama/Llama-3', ModelTier.FLAGSHIP, 5, 15),
      entry('together_ai', 'meta-llama/Llama-3-8b', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('together_ai', 'meta-llama/Llama-3', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.action).toBe(AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE);
    expect(out.draft_rule?.match.model).toBe('meta-llama/Llama-3');
    expect(out.draft_rule?.route_to.model).toBe('meta-llama/Llama-3-8b');
  });

  it('falls back to INVESTIGATE_DEEP_LINK when no downgrade target exists', () => {
    const c = catalog(entry('openai', 'gpt-4o-mini', ModelTier.MINI, 1, 3));
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o-mini', 30)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.action).toBe(AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK);
    // bug_001: dispatcher owns the URL; recommender doesn't stamp it.
    expect(out.deep_link_url).toBeUndefined();
  });

  it('skips model drivers with negative delta (cost drop, not growth)', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [
        { ...modelDriver('openai', 'gpt-4o', -50) },
        { kind: DriverKind.STEP, label: 'classify', delta_usd: 30 },
      ],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.action).toBe(AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK);
  });

  it('skips model drivers with no structured provider/model fields', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [{ kind: DriverKind.MODEL, label: 'mystery-model', delta_usd: 80 }],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.action).toBe(AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK);
  });
});

describe('recommendFromDiagnosis — draft rule survives the validator', () => {
  it('produced model_routing rule passes ruleCreateSchema', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    expect(out.draft_rule).toBeDefined();
    const candidate = {
      type: 'model_routing',
      enforcement: 'pre_call',
      name: 'B4-4 recommendation: openai/gpt-4o → gpt-4o-mini',
      enabled: true,
      config: out.draft_rule!,
    };
    const result = v.safeParse(ruleCreateSchema, candidate);
    if (!result.success) {
      throw new Error(`validator rejected draft rule: ${JSON.stringify(result.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });
});

describe('recommendFromDiagnosis — INVESTIGATE_DEEP_LINK fallback', () => {
  it('emits INVESTIGATE_DEEP_LINK when diagnosis has only iteration inflation', () => {
    const out = recommendFromDiagnosis(
      { iteration_inflation: { step_name: 'summarize', from: 10, to: 50 } },
      ctx(catalog()),
    );
    expect(out.action).toBe(AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK);
  });

  it('emits INVESTIGATE_DEEP_LINK for source-driven cost growth', () => {
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [{ kind: DriverKind.SOURCE, label: 'auto', delta_usd: 200 }],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(catalog()));
    expect(out.action).toBe(AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK);
  });
});

describe('recommendFromDiagnosis — projected savings', () => {
  it('omits projected_savings_usd when target ratio collapses to zero', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 0, 0), // 0 cost = 0 ratio
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 80)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    // Source cost is 0 → projectSavings returns 0 → field omitted.
    expect(out.projected_savings_usd).toBeUndefined();
  });

  it('rounds projected_savings_usd to 2 decimal places', () => {
    const c = catalog(
      entry('openai', 'gpt-4o', ModelTier.FLAGSHIP, 5, 15),
      entry('openai', 'gpt-4o-mini', ModelTier.STANDARD, 1, 3),
    );
    const diagnosis: AnomalyDiagnosis = {
      top_drivers: [modelDriver('openai', 'gpt-4o', 33.333333)],
    };
    const out = recommendFromDiagnosis(diagnosis, ctx(c));
    // ratio = 1 - 4/20 = 0.8 → 33.333333 * 0.8 = 26.666... → rounded 26.67
    expect(out.projected_savings_usd).toBe(26.67);
  });
});
