// B4-4 anomaly recommendations. Pure function that turns a deterministic
// AnomalyDiagnosis into a structured AnomalyRecommendation. The dashboard
// renders it; the "Apply as rule" path persists `draft_rule` as a draft
// model_routing rule. No LLM-generated text (D10).
//
// Three actions surface today:
//   - CREATE_DRAFT_MODEL_ROUTING_RULE: the diagnosis fingerprints a hot
//     model whose tier we know how to step down (flagship → standard or
//     standard → mini). The recommendation includes projected savings +
//     an A/B suggestion.
//   - INVESTIGATE_DEEP_LINK: the diagnosis is non-empty but doesn't
//     fingerprint a downgrade target (iteration inflation, source-side
//     spend, unknown-tier model). Operator gets a link to the dashboard's
//     anomaly context panel.
//   - DISMISS: empty diagnosis. The cron in B4-4b should usually skip
//     emitting the anomaly_event in this case; if it emits anyway, the
//     dismiss action is the surface.

import {
  AnomalyRecommendationAction,
  DEFAULT_MODEL_ROUTING_FALLBACK,
  DriverKind,
  type AnomalyDiagnosis,
  type AnomalyRecommendation,
  type ModelRoutingConfig,
  type ModelRoutingFallback,
  type RuleScope,
} from '@pylva/shared';

export const ModelTier = {
  FLAGSHIP: 'flagship',
  STANDARD: 'standard',
  MINI: 'mini',
  UNKNOWN: 'unknown',
} as const;

export type ModelTier = (typeof ModelTier)[keyof typeof ModelTier];

// Field names mirror `LlmPriceRow` in `src/lib/cost-calculator.ts` so the
// catalog can be assembled directly from the existing pricing infra
// without renaming.
export interface ModelTierEntry {
  provider: string;
  model: string;
  tier: ModelTier;
  input_per_1m_usd: number;
  output_per_1m_usd: number;
}

export interface ModelTierCatalog {
  /** All known models for the providers loaded by the host SDK. The
   *  recommendation engine looks up the diagnosis's top driver here to
   *  decide if a downgrade target exists. */
  byProviderModel: Map<string, ModelTierEntry>;
}

export interface RecommendationContext {
  catalog: ModelTierCatalog;
  customer_id: string | null;
  /** A/B suggestion default; overridable per-builder via
   *  MarginProtectionConfig.ab_suggestion_traffic_pct. */
  ab_suggestion_traffic_pct?: number;
  /** Defaults to per-customer when the anomaly is customer-scoped,
   *  pooled otherwise. */
  rule_scope?: RuleScope;
  /** Same defaults the SDK ships in B4-2c. Defaults to
   *  DEFAULT_MODEL_ROUTING_FALLBACK from @pylva/shared. */
  fallback?: ModelRoutingFallback;
}

const DEFAULT_AB_TRAFFIC_PCT = 10;

const TIER_DOWNGRADE: Partial<Record<ModelTier, ModelTier>> = {
  [ModelTier.FLAGSHIP]: ModelTier.STANDARD,
  [ModelTier.STANDARD]: ModelTier.MINI,
};

function pickTopModelDriver(
  diagnosis: AnomalyDiagnosis,
): { provider: string; model: string; delta_usd: number } | null {
  const drivers = diagnosis.top_drivers ?? [];
  for (const d of drivers) {
    if (d.kind !== DriverKind.MODEL) continue;
    if (d.delta_usd <= 0) continue; // only suggest downgrade for cost growth
    if (!d.provider || !d.model) continue; // structured ref required
    return { provider: d.provider, model: d.model, delta_usd: d.delta_usd };
  }
  return null;
}

function pickDowngradeTarget(
  catalog: ModelTierCatalog,
  source: ModelTierEntry,
): ModelTierEntry | null {
  const targetTier = TIER_DOWNGRADE[source.tier];
  if (!targetTier) return null;
  let best: ModelTierEntry | null = null;
  for (const candidate of catalog.byProviderModel.values()) {
    if (candidate.provider !== source.provider) continue;
    if (candidate.tier !== targetTier) continue;
    if (
      best == null ||
      candidate.input_per_1m_usd + candidate.output_per_1m_usd <
        best.input_per_1m_usd + best.output_per_1m_usd
    ) {
      best = candidate;
    }
  }
  return best;
}

// Approximation: assumes a 1:1 input/output token mix. Real workloads are
// usually output-skewed (GPT-4o is $2.50 input / $10 output — 4x weight),
// so this projection is conservative for output-heavy steps and may
// over-predict for input-heavy ones. B4-4b can pass an observed
// input:output ratio per builder once the cron has the cost_events data
// in hand; for now the aggregate ratio is the right starting heuristic.
function projectSavings(source: ModelTierEntry, target: ModelTierEntry, delta_usd: number): number {
  const sourceTotal = source.input_per_1m_usd + source.output_per_1m_usd;
  const targetTotal = target.input_per_1m_usd + target.output_per_1m_usd;
  if (sourceTotal <= 0) return 0;
  const ratio = Math.max(0, 1 - targetTotal / sourceTotal);
  return Math.round(delta_usd * ratio * 100) / 100;
}

function buildDraftRule(
  source: { provider: string; model: string },
  target: ModelTierEntry,
  ctx: RecommendationContext,
): ModelRoutingConfig {
  const scope = ctx.rule_scope ?? (ctx.customer_id ? 'per_customer' : 'pooled');
  return {
    scope,
    match: {
      // Match.customer_id is omitted on pooled rules: the validator
      // requires at least one match selector and provider+model satisfy
      // that, while a stale customer_id on a pooled rule is misleading.
      ...(scope === 'per_customer' && ctx.customer_id ? { customer_id: ctx.customer_id } : {}),
      provider: source.provider,
      model: source.model,
    },
    route_to: { provider: target.provider, model: target.model },
    fallback: ctx.fallback ?? DEFAULT_MODEL_ROUTING_FALLBACK,
  };
}

function modelKey(provider: string, model: string): string {
  // Local mirror of cost-calculator's `llmKey` separator. We don't import
  // that helper because it prefixes with `llm:` for the pricing-cache
  // namespace; the catalog Map only holds LLM rows so the prefix would
  // be redundant noise. Same `|` separator keeps lookups interoperable.
  return `${provider}|${model}`;
}

export function recommendFromDiagnosis(
  diagnosis: AnomalyDiagnosis,
  ctx: RecommendationContext,
): AnomalyRecommendation {
  // Empty diagnosis → only a dismiss action makes sense. Note that
  // `insufficient_revenue_data` counts as content: it's a meaningful
  // signal ("we can't compute margin for this customer") that the
  // operator deserves to see, so we fall through to INVESTIGATE_DEEP_LINK
  // rather than silently dismissing. This matches the runner's own
  // emptiness check (runner.ts:166-174) — without parity here the
  // detector hit was being silently dropped (bug_009).
  const hasContent = !!(
    diagnosis.top_drivers?.length ||
    diagnosis.iteration_inflation ||
    diagnosis.notes?.length ||
    diagnosis.insufficient_revenue_data
  );
  if (!hasContent) {
    return { action: AnomalyRecommendationAction.DISMISS };
  }

  // Try to fingerprint a hot model that has a known downgrade target.
  const driver = pickTopModelDriver(diagnosis);
  if (driver) {
    const sourceEntry = ctx.catalog.byProviderModel.get(modelKey(driver.provider, driver.model));
    if (sourceEntry && sourceEntry.tier !== ModelTier.UNKNOWN) {
      const target = pickDowngradeTarget(ctx.catalog, sourceEntry);
      if (target) {
        const projected = projectSavings(sourceEntry, target, driver.delta_usd);
        const draftRule = buildDraftRule(driver, target, ctx);
        const trafficPct = ctx.ab_suggestion_traffic_pct ?? DEFAULT_AB_TRAFFIC_PCT;
        return {
          action: AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE,
          ...(projected > 0 ? { projected_savings_usd: projected } : {}),
          ab_suggestion: {
            traffic_pct: trafficPct,
            rationale:
              `Try routing ${trafficPct}% of traffic to ${target.model} ` +
              `first to validate quality before full rollout.`,
          },
          draft_rule: draftRule,
        };
      }
    }
  }

  // Diagnosis exists but no actionable downgrade — point the operator
  // at the cost dashboard. The deep-link URL is constructed by the
  // dispatcher (`src/lib/alerts/deep-link.ts`) from the anomaly id and
  // the caller's builder slug; we do NOT stamp it here because at
  // recommendation time we have neither the real anomaly id (the row
  // hasn't been inserted yet) nor a slug (only the builder UUID).
  // Letting the dispatcher win avoids the bug_001 broken-URL trap.
  return {
    action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK,
  };
}
