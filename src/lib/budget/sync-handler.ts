// B2a T3 — /api/v1/budget/sync business logic.
// SDK posts accumulator snapshots (per rule × scope × customer × period_start);
// we reconcile by re-aggregating ClickHouse for each entry and returning the
// server truth. SDK applies setFromSync() to replace local (I-T3-3).

import { getRule } from '../rules/repository.js';
import { aggregateSpendForRule, type AggregationWindow } from './aggregate.js';
import { periodStartFor, periodEndFor } from './period-utils.js';
import { extractExternalCustomerId, toCompositeCustomerId } from '../clickhouse/customer-id.js';
import {
  RuleStatus,
  type BudgetSyncRequest,
  type BudgetSyncResponse,
  type Rule,
  type RulePeriod,
} from '@pylva/shared';

interface ResolvedRuleMatch {
  rule: Rule;
  limit_usd: number | null;
}

type ResolvedScope = 'per_customer' | 'pooled';

/**
 * Look up the sync entry's rule by id (builder-scoped) and check it still
 * applies. Lookup-by-id, NOT listActiveRulesForCustomer: pooled entries
 * sync with customer_id=null, so a legacy pooled rule that still carries a
 * customer target never appeared in a null-customer listing — every sync
 * took the "deleted" zero-total path and wiped the SDK's accumulated state
 * (blocked customers oscillated back to unblocked each cycle). Returns the
 * budget limit if the rule is a budget_limit; null limit otherwise
 * (cost_threshold etc. have no limit).
 */
async function resolveRuleLimit(
  builderId: string,
  ruleId: string,
  customerId: string | null,
): Promise<ResolvedRuleMatch | null> {
  const rule = await getRule(builderId, ruleId);
  if (!rule || !rule.enabled || rule.status !== RuleStatus.ACTIVE) return null;
  // Pooled rules aggregate across all end-users, so any entry reconciles.
  // Per-customer rules apply when untargeted or targeted at this customer.
  if (
    scopeForRule(rule) === 'per_customer' &&
    rule.customer_id !== null &&
    rule.customer_id !== customerId
  ) {
    return null;
  }
  const cfg = rule.config as { limit_usd?: number };
  return {
    rule,
    limit_usd: typeof cfg.limit_usd === 'number' ? cfg.limit_usd : null,
  };
}

// Sanity bounds for the client-supplied period_start. Outside this range the
// date still parses but chTimestamp() emits a malformed ClickHouse literal
// (e.g. year +275760 overflows the YYYY-MM-DD slice) and the query throws —
// a client-triggerable 500. Anything outside it is garbage, not skew.
const MIN_PERIOD_START_MS = Date.UTC(2000, 0, 1);
const MAX_PERIOD_START_MS = Date.UTC(2100, 0, 1);

/**
 * [from, to) window of the rule's period containing `periodStartIso`.
 * Well-behaved SDKs send an exact period boundary, so `from` round-trips
 * unchanged. An unparseable or out-of-bounds timestamp falls back to the
 * server-clock current period (the pre-fix behavior).
 */
function windowForEntry(rule: Rule, periodStartIso: string): AggregationWindow {
  const period = (rule.config as { period: RulePeriod }).period;
  const parsedMs = new Date(periodStartIso).getTime();
  const anchor =
    parsedMs >= MIN_PERIOD_START_MS && parsedMs < MAX_PERIOD_START_MS
      ? new Date(parsedMs)
      : new Date();
  return {
    from: periodStartFor(period, anchor),
    to: periodEndFor(period, anchor),
  };
}

function scopeForRule(rule: Rule): ResolvedScope {
  const cfg = rule.config as { scope?: ResolvedScope };
  return cfg.scope === 'pooled' ? 'pooled' : 'per_customer';
}

export async function reconcileBudgetSync(
  builderId: string,
  entries: BudgetSyncRequest[],
): Promise<BudgetSyncResponse[]> {
  const results = await Promise.all(
    entries.map(async (entry) => {
      const externalCustomerId = entry.customer_id
        ? extractExternalCustomerId(entry.customer_id, builderId)
        : null;
      const match = await resolveRuleLimit(builderId, entry.rule_id, externalCustomerId);
      if (!match) {
        // Rule was deleted between the SDK's last fetch + this sync call.
        // Return server_total=0 so the SDK trims its accumulator.
        return {
          rule_id: entry.rule_id,
          scope: entry.scope,
          customer_id: externalCustomerId,
          period_start: entry.period_start,
          server_total_usd: 0,
          budget_remaining_usd: null,
          budget_exceeded: false,
          reconciled_at: new Date().toISOString(),
        } satisfies BudgetSyncResponse;
      }
      const ruleScope = scopeForRule(match.rule);
      const scopedCompositeCustomerId =
        ruleScope === 'pooled' || !externalCustomerId
          ? null
          : toCompositeCustomerId(builderId, externalCustomerId);
      // The response echoes entry.period_start as the SDK's accumulator key,
      // so the total MUST be aggregated over the period containing that
      // timestamp — not the server-clock current period. Aggregating by the
      // server clock made a sync that crossed a period boundary (in-flight
      // latency or SDK↔server clock skew) return one period's total keyed as
      // another: the SDK then either wiped its accumulated spend (budget
      // under-enforced) or double-counted the finished period into the new
      // one (hard_stop falsely blocking traffic until the next sync).
      const total = await aggregateSpendForRule(
        builderId,
        match.rule,
        scopedCompositeCustomerId,
        windowForEntry(match.rule, entry.period_start),
      );
      const budgetExceeded = match.limit_usd !== null && total >= match.limit_usd;
      return {
        rule_id: entry.rule_id,
        scope: entry.scope,
        customer_id: externalCustomerId,
        period_start: entry.period_start,
        server_total_usd: total,
        budget_remaining_usd:
          match.limit_usd !== null ? Math.max(match.limit_usd - total, 0) : null,
        budget_exceeded: budgetExceeded,
        reconciled_at: new Date().toISOString(),
      } satisfies BudgetSyncResponse;
    }),
  );
  return results;
}
