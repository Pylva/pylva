// Rule-type categorization helpers shared across the rules CRUD routes,
// the activate route, the SDK engine boundary, and any future dashboard
// surface. Centralizes the "advanced vs basic" split so the tier-gate +
// consent enforcement surfaces stay aligned.

import { RuleType, type RuleType as RuleTypeT } from '@pylva/shared';

// Advanced rule types start as drafts on POST and require pro+ tier
// (and, for failover, explicit consent_to_cost_shift) before they can
// flip to status='active'.
export const ADVANCED_RULE_TYPES: ReadonlySet<RuleTypeT> = new Set<RuleTypeT>([
  RuleType.MODEL_ROUTING,
  RuleType.RELIABILITY_FAILOVER,
  RuleType.MARGIN_PROTECTION,
]);

export function isAdvancedRuleType(t: string): t is RuleTypeT {
  return ADVANCED_RULE_TYPES.has(t as RuleTypeT);
}

// Pre-call rule types reshape the LLM call before it leaves the SDK
// (block, route, failover). Activation should warn that "live SDK
// traffic" is affected. Post-call types only fire alerts.
export const LIVE_TRAFFIC_RULE_TYPES: ReadonlySet<RuleTypeT> = new Set<RuleTypeT>([
  RuleType.MODEL_ROUTING,
  RuleType.RELIABILITY_FAILOVER,
  RuleType.BUDGET_LIMIT,
]);

export function affectsLiveTraffic(t: RuleTypeT): boolean {
  return LIVE_TRAFFIC_RULE_TYPES.has(t);
}
