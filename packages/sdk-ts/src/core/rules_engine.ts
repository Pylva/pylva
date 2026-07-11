// B4-T1 SDK pre-call rules engine. Pure module: takes the cached rules +
// per-call context, returns a single RuleDecision the wrapper applies.
// All ClickHouse / network I/O is the wrapper's job; this engine is
// strictly local and synchronous so the hot path stays cheap.
//
// Conflict resolution (b4 plan D27): most-specific-wins. Specificity
// scoring is documented in resolveConflict() — same score → most recently
// updated rule takes precedence.

import {
  RuleType,
  RuleDecisionAction,
  RuleConflictResolution,
  type RuleDecision,
  type ModelRoutingConfig,
  type ModelRoutingFallback,
  type ModelRoutingMatch,
  type ModelRoutingTarget,
  type ReliabilityFailoverConfig,
  type RuleType as RuleTypeT,
} from '@pylva/shared';

// Minimal cached-rule shape. We narrow at the engine boundary so the
// rest of the engine can rely on the typed config without re-checking.
export interface CachedRule {
  id: string;
  type: RuleTypeT;
  enabled: boolean;
  status: 'active' | 'draft';
  customer_id: string | null;
  config: Record<string, unknown>;
  updated_at: string | Date;
}

export interface PreCallContext {
  customer_id: string | null;
  step_name: string | null;
  provider: string | null;
  model: string | null;
}

const ALLOW: RuleDecision = { action: RuleDecisionAction.ALLOW };

// Coarse type guards. The rules cache is `unknown[]`; the engine doesn't
// trust its shape and skips malformed entries instead of throwing.
function isCached(raw: unknown): raw is CachedRule {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['type'] === 'string' &&
    typeof r['enabled'] === 'boolean' &&
    (r['status'] === 'active' || r['status'] === 'draft') &&
    typeof r['config'] === 'object' &&
    r['config'] !== null
  );
}

export function narrowRules(raw: unknown[]): CachedRule[] {
  const out: CachedRule[] = [];
  for (const r of raw) {
    if (!isCached(r)) continue;
    if (!r.enabled) continue;
    if (r.status !== 'active') continue;
    out.push(r);
  }
  return out;
}

// Score how specific a model_routing rule is for the given context.
// Higher = more specific. Returns null when the rule's match selectors
// don't match the context at all.
function scoreModelRouting(
  cfg: ModelRoutingConfig,
  ctx: PreCallContext,
  ruleCustomerId: string | null,
): RuleConflictResolution | null {
  // The cache is unvalidated JSON: `config.match` may be missing or have a
  // different shape after a backend schema bump. Reading it blindly threw
  // out of evaluatePreCall and the wrapper rethrew to the host — an R1
  // violation (sdk-py guards this; bug_013 class). Degrade, never throw.
  const rawMatch = (cfg as { match?: unknown }).match;
  const match: Partial<ModelRoutingMatch> =
    typeof rawMatch === 'object' && rawMatch !== null
      ? (rawMatch as Partial<ModelRoutingMatch>)
      : {};

  // Customer match: rule.customer_id (column) takes precedence over the
  // config-level match.customer_id; either must align with the context.
  const ruleCustomer = ruleCustomerId ?? match.customer_id ?? null;
  if (ruleCustomer !== null && ruleCustomer !== ctx.customer_id) return null;

  if (match.step_name && match.step_name !== ctx.step_name) return null;
  if (match.provider && match.provider !== ctx.provider) return null;
  if (match.model && match.model !== ctx.model) return null;

  const customer = ruleCustomer !== null;
  const step = !!match.step_name;
  const model = !!match.model;

  if (customer && step && model) return RuleConflictResolution.CUSTOMER_STEP_MODEL;
  if (customer && step) return RuleConflictResolution.CUSTOMER_STEP;
  if (customer) return RuleConflictResolution.CUSTOMER;
  if (step && model) return RuleConflictResolution.GLOBAL_STEP_MODEL;
  if (step) return RuleConflictResolution.GLOBAL_STEP;
  return RuleConflictResolution.GLOBAL;
}

interface RoutingCandidate {
  rule: CachedRule;
  cfg: ModelRoutingConfig;
  score: RuleConflictResolution;
}

function pickRoutingRule(rules: CachedRule[], ctx: PreCallContext): RoutingCandidate | null {
  const candidates: RoutingCandidate[] = [];
  for (const rule of rules) {
    if (rule.type !== RuleType.MODEL_ROUTING) continue;
    const cfg = rule.config as unknown as ModelRoutingConfig;
    const score = scoreModelRouting(cfg, ctx, rule.customer_id);
    if (score === null) continue;
    candidates.push({ rule, cfg, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // Same specificity → most recently updated wins.
    const aTs = new Date(a.rule.updated_at).getTime();
    const bTs = new Date(b.rule.updated_at).getTime();
    return bTs - aTs;
  });
  return candidates[0]!;
}

// Narrow the winning rule's route_to / fallback before they reach the
// RuleDecision (which promises concrete strings + a fallback object to the
// wrapper). Same R1 rationale as scoreModelRouting: a partial cached config
// must degrade to "don't route", not throw mid-call.
function routingApplication(
  cfg: ModelRoutingConfig,
): { route_to: ModelRoutingTarget; fallback: ModelRoutingFallback } | null {
  const routeTo = (cfg as { route_to?: unknown }).route_to;
  const fallback = (cfg as { fallback?: unknown }).fallback;
  if (typeof routeTo !== 'object' || routeTo === null) return null;
  const target = routeTo as Partial<ModelRoutingTarget>;
  if (typeof target.provider !== 'string' || typeof target.model !== 'string') return null;
  if (typeof fallback !== 'object' || fallback === null || Array.isArray(fallback)) return null;
  return {
    route_to: { provider: target.provider, model: target.model },
    fallback: fallback as ModelRoutingFallback,
  };
}

// Failover rules apply per-customer only (b4 plan §5.1). The engine
// doesn't *trigger* failover here — that decision belongs to failover.ts
// which tracks per-instance error rates. Engine returns the rule so the
// wrapper can consult the failover state machine to decide whether to
// route to backup or primary.
export interface FailoverRuleMatch {
  rule_id: string;
  cfg: ReliabilityFailoverConfig;
}

function findFailoverRule(rules: CachedRule[], ctx: PreCallContext): FailoverRuleMatch | null {
  for (const rule of rules) {
    if (rule.type !== RuleType.RELIABILITY_FAILOVER) continue;
    const cfg = rule.config as unknown as ReliabilityFailoverConfig;
    if (!cfg.enabled) continue;
    if (cfg.customer_id !== ctx.customer_id) continue;
    if (cfg.primary_provider !== ctx.provider) continue;
    return { rule_id: rule.id, cfg };
  }
  return null;
}

export interface EngineEvaluation {
  decision: RuleDecision;
  routing?: RoutingCandidate;
  failover?: FailoverRuleMatch;
}

export function evaluatePreCall(rawRules: unknown[], ctx: PreCallContext): EngineEvaluation {
  const rules = narrowRules(rawRules);

  // 1. Failover rule lookup (the wrapper consults failover.ts to decide
  // whether to route to backup; engine just surfaces the matching rule).
  const failover = findFailoverRule(rules, ctx);

  // 2. Model routing: most-specific-wins.
  const routing = pickRoutingRule(rules, ctx);
  if (routing) {
    const applicable = routingApplication(routing.cfg);
    if (!applicable) {
      // Malformed route_to / fallback on the winning rule. Mirror sdk-py's
      // `decision.model and decision.fallback` guard in _engine.py: keep the
      // winner (don't promote a less specific rule) but skip routing — the
      // call proceeds with the original model instead of throwing (R1).
      return failover ? { decision: ALLOW, failover } : { decision: ALLOW };
    }
    return {
      decision: {
        action: RuleDecisionAction.ROUTE_MODEL,
        rule_id: routing.rule.id,
        provider: applicable.route_to.provider,
        model: applicable.route_to.model,
        original_model: ctx.model ?? '',
        fallback: applicable.fallback,
      },
      routing,
      ...(failover ? { failover } : {}),
    };
  }

  return failover ? { decision: ALLOW, failover } : { decision: ALLOW };
}

// Test-only reset hooks.
export function _resetEngineForTests(): void {
  // No mutable engine state today. Keep the hook for test parity.
}
