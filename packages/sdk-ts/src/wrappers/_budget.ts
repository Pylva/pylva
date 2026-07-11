// B2a — shared pre-call budget hook used by all LLM wrappers
// (openai, anthropic, vercel-ai). The wrapper calls `maybeEnforcePreCall`
// before invoking the real client. If a hard_stop budget_limit rule is
// crossed, this throws PylvaBudgetExceeded{source:'sdk_precall'};
// otherwise it either no-ops (passthrough) or emits an advisory warning
// and returns (advisory mode).
//
// This file is size-budgeted. Target gzipped < 700 B (B1 per-wrapper budget).

import { ensureRulesCache, getCachedRules, isPassthrough } from '../core/rules_cache.js';
import { check } from '../core/budget_accumulator.js';
import {
  findApplicableBudgetRules,
  narrowRule,
  periodStartUtc,
  type MinimalRule,
} from '../core/budget_rules.js';
import { PylvaBudgetExceeded, BudgetExceededSource } from '../errors/budget_exceeded.js';

export interface PreCallInput {
  customer_id: string | null;
  estimated_usd: number;
}

/**
 * Pre-call hook. Returns nothing on pass. Throws PylvaBudgetExceeded
 * on hard-stop violation. Emits a one-per-minute advisory warning on
 * soft (non-hard_stop) over-budget.
 *
 * Enforces EVERY applicable budget rule (parity with the server's
 * computeBudgetExceededFlags AND-semantics): the strictest rule wins; a
 * customer-specific cap is never shadowed by a newer global rule.
 *
 * Invariants:
 *  - I-T3-1 passthrough: if rules cache is cold or degraded, the check is a
 *    no-op — the call proceeds.
 *  - I-T3-2 source: the thrown error carries source='sdk_precall'.
 */
export function maybeEnforcePreCall(input: PreCallInput): void {
  // Fire-and-forget refresh so the cache is warm next call. Never awaited:
  // the first call after cold boot skips enforcement trivially (I-T3-1).
  void ensureRulesCache().catch(() => {
    /* R1 */
  });

  if (isPassthrough()) return;

  const rules = getCachedRules()
    .map(narrowRule)
    .filter((r): r is MinimalRule => r !== null);
  if (rules.length === 0) return;

  for (const match of findApplicableBudgetRules(rules, input.customer_id)) {
    const period_start = periodStartUtc(match.period);
    const result = check({
      rule_id: match.rule_id,
      scope: match.scope,
      customer_id: match.scope_token_customer_id,
      period_start,
      estimated_usd: input.estimated_usd,
      limit_usd: match.limit_usd,
    });
    if (!result.over_limit) continue;

    if (match.hard_stop) {
      throw new PylvaBudgetExceeded({
        source:
          result.source === BudgetExceededSource.BACKEND_INGEST_FLAG
            ? BudgetExceededSource.BACKEND_INGEST_FLAG
            : BudgetExceededSource.SDK_PRECALL,
        rule_id: match.rule_id,
        customer_id: match.scope_token_customer_id,
        period: match.period,
        period_start,
        limit_usd: match.limit_usd,
        accumulated_usd: result.accumulated_usd,
        estimated_usd: input.estimated_usd,
      });
    }

    // Advisory mode: log once per minute for visibility; call proceeds.
    advisoryWarn(match.rule_id, result.projected_usd, match.limit_usd);
  }
}

const advisoryLog = new Map<string, number>();
function advisoryWarn(rule_id: string, projected: number, limit: number): void {
  const now = Date.now();
  const last = advisoryLog.get(rule_id) ?? 0;
  if (now - last < 60_000) return;
  advisoryLog.set(rule_id, now);
  console.warn(
    `[pylva] advisory: rule ${rule_id} projected $${projected.toFixed(2)} vs limit $${limit.toFixed(2)}`,
  );
}
