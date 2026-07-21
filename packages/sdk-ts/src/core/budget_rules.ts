// Budget-rule matching, period math, and local spend recording shared by the
// pre-call hook (wrappers/_budget) and the telemetry exporter (core/telemetry).
// Lives in core/ so telemetry can record spend without importing wrapper code.

import { getCachedRules, isPassthrough } from './rules_cache.js';
import { ensurePricingCache, getPricing } from './pricing_cache.js';
import { add, type Period, type Scope } from './budget_accumulator.js';

// Minimal shape we read off the cached rule. The cache stores `unknown[]`;
// we narrow defensively at the callsite.
export interface MinimalRule {
  id: string;
  type: string;
  enabled: boolean;
  customer_id: string | null;
  config: Record<string, unknown>;
}

export function narrowRule(raw: unknown): MinimalRule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string') return null;
  if (typeof r['type'] !== 'string') return null;
  if (typeof r['enabled'] !== 'boolean') return null;
  return {
    id: r['id'],
    type: r['type'],
    enabled: r['enabled'],
    customer_id: typeof r['customer_id'] === 'string' ? r['customer_id'] : null,
    config:
      typeof r['config'] === 'object' && r['config'] !== null
        ? (r['config'] as Record<string, unknown>)
        : {},
  };
}

export interface BudgetRuleMatch {
  rule_id: string;
  scope: Scope;
  scope_token_customer_id: string | null;
  period: Period;
  limit_usd: number;
  hard_stop: boolean;
}

/**
 * Every active `budget_limit` rule that applies to the given customer, in
 * cache order. The server (`computeBudgetExceededFlags`) evaluates ALL
 * applicable budget rules per customer, so the SDK must match: a
 * customer-specific cap is a constraint IN ADDITION to any global rule,
 * never shadowed by it. Matching:
 *   rule.customer_id === null → applies to all end-users (scope flag
 *   disambiguates per_customer vs pooled). rule.customer_id === customerId
 *   matches that customer only.
 */
export function findApplicableBudgetRules(
  rules: MinimalRule[],
  customerId: string | null,
): BudgetRuleMatch[] {
  const matches: BudgetRuleMatch[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.type !== 'budget_limit') continue;
    const { limit_usd, period, hard_stop, scope } = rule.config as {
      limit_usd?: unknown;
      period?: unknown;
      hard_stop?: unknown;
      scope?: unknown;
    };
    if (typeof limit_usd !== 'number' || !Number.isFinite(limit_usd) || limit_usd <= 0) continue;
    if (period !== 'hour' && period !== 'day' && period !== 'week' && period !== 'month') continue;
    if (scope !== 'per_customer' && scope !== 'pooled') continue;
    if (typeof hard_stop !== 'boolean') continue;
    if (rule.customer_id !== null && rule.customer_id !== customerId) continue;

    matches.push({
      rule_id: rule.id,
      scope,
      scope_token_customer_id: scope === 'pooled' ? null : customerId,
      period,
      limit_usd,
      hard_stop,
    });
  }
  return matches;
}

export function periodStartUtc(period: Period, at: Date = new Date()): string {
  const d = new Date(at.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  if (period === 'hour') return d.toISOString();
  d.setUTCHours(0);
  if (period === 'day') return d.toISOString();
  if (period === 'week') {
    // ISO-8601 Monday-start week. Shift back to Monday.
    const dow = d.getUTCDay();
    const back = (dow + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString();
  }
  // month
  d.setUTCDate(1);
  return d.toISOString();
}

export interface LlmSpendInput {
  customer_id: string | null;
  provider: string | null;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
}

/**
 * Record the actual cost of a completed LLM call against every applicable
 * budget rule's accumulator key, priced from the local pricing cache. This
 * keeps hard stops near-real-time in-process instead of waiting for the
 * backend ingest flag or the 5-min sync (which bound the error but leave an
 * overshoot window). Fail-open: unknown pricing, degraded rules cache, or
 * zero-token events are a no-op — the backend flag stays authoritative and
 * the 5-min sync replaces local totals with server truth (I-T3-3).
 */
export function recordLlmSpend(input: LlmSpendInput): void {
  // Fire-and-forget warm so the cache is fresh for subsequent calls.
  void ensurePricingCache().catch(() => {
    /* R1 */
  });
  if (isPassthrough()) return;
  if (!input.provider || !input.model) return;
  const tokensIn = Number.isFinite(input.tokens_in) && input.tokens_in > 0 ? input.tokens_in : 0;
  const tokensOut =
    Number.isFinite(input.tokens_out) && input.tokens_out > 0 ? input.tokens_out : 0;
  if (tokensIn === 0 && tokensOut === 0) return;
  const pricing = getPricing(input.provider, input.model);
  if (!pricing) return;
  const cost = (tokensIn * pricing.input_per_1m + tokensOut * pricing.output_per_1m) / 1_000_000;
  if (!(cost > 0)) return;

  const rules = getCachedRules()
    .map(narrowRule)
    .filter((r): r is MinimalRule => r !== null);
  if (rules.length === 0) return;
  for (const match of findApplicableBudgetRules(rules, input.customer_id)) {
    add(
      {
        rule_id: match.rule_id,
        scope: match.scope,
        customer_id: match.scope_token_customer_id,
        period_start: periodStartUtc(match.period),
      },
      cost,
    );
  }
}
