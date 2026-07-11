// B2a T3 — post-call rule evaluation (§6 + D2).
// Invoked as `void evaluatePostCall(...).catch(logErr)` immediately after
// the ingest route returns its response. On ECS we have the full container
// lifetime to complete the retry budget (~36s); SIGTERM flushes pending
// batches via src/lib/alerts/batcher.ts.

import { logger } from '../logger.js';
import { extractExternalCustomerId } from '../clickhouse/customer-id.js';
import {
  listActiveRulesForCustomer,
  listAlertChannelEntriesForRule,
  markRuleTriggered,
} from './repository.js';
import { periodStartFor, periodEndFor } from '../budget/period-utils.js';
import { aggregateSpendForRule } from '../budget/aggregate.js';
import { deliverAlert } from '../alerts/delivery.js';
import { buildCostThresholdPayload, buildBudgetExceededPayload } from '../alerts/payloads.js';
import {
  RuleEnforcement,
  RuleStatus,
  type Rule,
  type RulePeriod,
  type RuleScope,
} from '@pylva/shared';

const log = logger.child({ module: 'rules.post-call-evaluator' });

// Per-period dedup keyed on `${rule_id}|${scope_token}|${period_start}`,
// valued with the period's END (ms epoch). In-process Map is good enough on
// a single ECS task; multi-container dedup can move to Redis SET in B3 when
// we add a durable queue.
const firedThisPeriod = new Map<string, number>();
// Cheap eviction: every 5 min, drop keys whose period has ENDED. Evicting by
// period-start age instead would wipe live week/month keys two days into the
// period and re-fire the same alert on every subsequent ingest.
setInterval(
  () => {
    const now = Date.now();
    for (const [k, periodEndMs] of firedThisPeriod) {
      if (now >= periodEndMs) firedThisPeriod.delete(k);
    }
  },
  5 * 60 * 1000,
).unref?.();

interface InsertedEvent {
  customer_id: string; // composite "{builderId}:{external}" per ingest route
  cost_usd: number | null;
  timestamp: string;
}

function scopeToken(scope: RuleScope, customer_id: string): string {
  return scope === 'pooled' ? '__pooled__' : customer_id;
}

function dedupKey(ruleId: string, scopeToken: string, periodStart: string): string {
  return `${ruleId}|${scopeToken}|${periodStart}`;
}

export async function evaluatePostCall(
  builderId: string,
  insertedEvents: InsertedEvent[],
): Promise<void> {
  // Gather the distinct set of customer_ids that just had events.
  const touchedCustomers = new Set(insertedEvents.map((e) => e.customer_id));
  if (touchedCustomers.size === 0) return;

  // For each touched customer, fetch rules that apply + run each at most once
  // per period.
  const perCustomer = Array.from(touchedCustomers).map(async (compositeCustomerId) => {
    const externalCustomerId = extractExternalCustomerId(compositeCustomerId, builderId);
    try {
      const rules = await listActiveRulesForCustomer(builderId, externalCustomerId);
      await Promise.allSettled(
        rules.map((rule) => evalOneRule(builderId, rule, compositeCustomerId, externalCustomerId)),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          builder_id: builderId,
          customer_id: externalCustomerId,
          error: msg,
        },
        'rule eval failed for customer',
      );
    }
  });
  await Promise.allSettled(perCustomer);
}

async function evalOneRule(
  builderId: string,
  rule: Rule,
  compositeCustomerId: string,
  externalCustomerId: string,
): Promise<void> {
  if (!rule.enabled || rule.status !== RuleStatus.ACTIVE) return;

  const cfg = rule.config as {
    period: RulePeriod;
    scope?: RuleScope;
    threshold_usd?: number;
    limit_usd?: number;
  };

  // Only post-call-eligible types. budget_limit's primary enforcement is
  // pre-call (SDK), but post-call still watches for cross-container overshoot.
  const type = rule.type;
  if (type !== 'cost_threshold' && type !== 'budget_limit') {
    // Margin protection is evaluated by the anomaly/margin diagnosis cron,
    // not the automatic post-call threshold path.
    return;
  }

  const scope: RuleScope = cfg.scope ?? 'per_customer';
  const scopedCompositeCustomerId = scope === 'pooled' ? null : compositeCustomerId;
  const scopedExternalCustomerId = scope === 'pooled' ? null : externalCustomerId;

  // Compute the aggregate — scoped or pooled. Shared with the ingest
  // route's budget_exceeded flag path and the /budget/sync handler.
  const total = await aggregateSpendForRule(builderId, rule, scopedCompositeCustomerId);
  const periodStartIso = periodStartFor(cfg.period).toISOString();
  const key = dedupKey(rule.id, scopeToken(scope, externalCustomerId), periodStartIso);

  let crossed = false;
  if (type === 'cost_threshold' && cfg.threshold_usd !== undefined) {
    crossed = total >= cfg.threshold_usd;
  } else if (type === 'budget_limit' && cfg.limit_usd !== undefined) {
    crossed = total >= cfg.limit_usd;
  }
  if (!crossed) return;

  // Per-period dedup (I-T3-12: key includes scope so per-customer doesn't
  // dedup against pooled). Reserve BEFORE dispatch so concurrent ingest
  // batches can't double-fire, but roll back in the catch below — leaving
  // the key set on failure meant one transient channel-load/dispatch error
  // silenced the alert for the entire remaining period (B7).
  if (firedThisPeriod.has(key)) return;
  firedThisPeriod.set(key, periodEndFor(cfg.period).getTime());

  try {
    // Load channels + build payload + dispatch. deliverAlert writes alert_history.
    const channels = await listAlertChannelEntriesForRule(builderId, rule.id);

    // 'blocked' is a claim about what happened to traffic: only pre-call
    // hard stops actually refuse calls. A post_call budget rule (or a
    // soft rule) observed the overshoot after the fact — reporting
    // 'blocked' to a builder's webhook would misstate that their
    // customer's calls were stopped (B10).
    const actuallyBlocks =
      (rule.config as { hard_stop?: boolean }).hard_stop === true &&
      rule.enforcement === RuleEnforcement.PRE_CALL;

    const payload =
      type === 'cost_threshold'
        ? {
            version: '1.0' as const,
            rule_id: rule.id,
            fired_at: new Date().toISOString(),
            payload: buildCostThresholdPayload(rule, {
              builder_id: builderId,
              customer_id: scopedExternalCustomerId,
              current_usd: total,
              period_start: periodStartIso,
            }),
          }
        : {
            version: '1.0' as const,
            rule_id: rule.id,
            fired_at: new Date().toISOString(),
            payload: buildBudgetExceededPayload(
              rule,
              {
                builder_id: builderId,
                customer_id: scopedExternalCustomerId,
                current_usd: total,
                period_start: periodStartIso,
              },
              actuallyBlocks ? 'blocked' : 'warned',
            ),
          };

    await deliverAlert({
      builder_id: builderId,
      rule_id: rule.id,
      payload,
      channels,
    });
    // Dashboard freshness signal (B4-4c) — best-effort; a failed stamp
    // must not release the dedup reservation and re-page the builder.
    await markRuleTriggered(builderId, rule.id).catch(() => undefined);

    log.info(
      {
        builder_id: builderId,
        rule_id: rule.id,
        customer_id: externalCustomerId,
        total_usd: total,
      },
      'rule fired',
    );
  } catch (err) {
    firedThisPeriod.delete(key);
    log.warn(
      {
        builder_id: builderId,
        rule_id: rule.id,
        customer_id: externalCustomerId,
        error: err instanceof Error ? err.message : String(err),
      },
      'rule fire dispatch failed; dedup released so the next ingest retries',
    );
  }
}

/** Test helper — clears in-memory dedup state. */
export function _resetPostCallEvalForTests(): void {
  firedThisPeriod.clear();
}
