// Shared "aggregate spend for a rule over a period" query.
// Extracted from the three places that inlined the same SQL: the ingest
// route's budget_exceeded flag computation, the post-call evaluator's
// currentPeriodTotal (both: server-clock current period, no upper bound),
// and the budget/sync handler's serverTotal (explicit [from, to) window of
// the period the SDK asked about).
//
// Scope semantics:
//   - `customerId === null` → pooled: sum across all customers
//   - `customerId !== null` → per-customer: sum for that customer only
// Callers pass the already-resolved `scopedCustomerId` (null if the rule
// is pooled) so this helper has no knowledge of RuleScope.

import { queryCostEvents } from '../clickhouse/client.js';
import { chTimestamp } from '../clickhouse/datetime.js';
import { periodStartFor } from './period-utils.js';
import type { Rule, RulePeriod } from '@pylva/shared';

// Half-open [from, to) aggregation window. When omitted, the window is the
// server-clock current period with no upper bound (correct for "spend so
// far this period" callers: ingest flag + post-call evaluator).
export interface AggregationWindow {
  from: Date;
  to: Date;
}

export async function aggregateSpendForRule(
  builderId: string,
  rule: Rule,
  scopedCustomerId: string | null,
  window?: AggregationWindow,
): Promise<number> {
  const period = (rule.config as { period: RulePeriod }).period;
  const from = window?.from ?? periodStartFor(period);
  const customerFilter = scopedCustomerId ? 'AND customer_id = {customer_id:String}' : '';
  const upperBoundFilter = window
    ? "AND timestamp < parseDateTime64BestEffort({to:String}, 3, 'UTC')"
    : '';
  const rows = await queryCostEvents(
    builderId,
    // is_demo = 0 mirrors previewRule + every dashboard query: rules and
    // budget enforcement act on REAL traffic only. Without this, seeded
    // demo events (is_demo=1, never purged) are summed into the
    // period total, so a pooled cost_threshold/budget_limit rule fires —
    // or the SDK budget_exceeded flag hard-stops a real call — on fake
    // money, while previewRule (which DOES filter is_demo) shows $0.
    `SELECT sum(cost_usd) AS s
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND is_demo = 0
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       ${upperBoundFilter}
       ${customerFilter}`,
    {
      from: chTimestamp(from),
      ...(window ? { to: chTimestamp(window.to) } : {}),
      ...(scopedCustomerId ? { customer_id: scopedCustomerId } : {}),
    },
  );
  const row = rows[0] as { s?: string | number } | undefined;
  return Number(row?.s ?? 0);
}
