// B2a — PylvaBudgetExceeded.
//
// Thrown by the SDK when a pre-call check sees the accumulated spend + the
// estimated next-call cost crossing a hard_stop budget_limit rule, OR on
// the next call after the backend ingest response carries a budget_exceeded
// flag for the same (rule, scope_token, customer_id) key.
//
// The error carries enough context for the builder to render a useful
// user-facing message ("Your acme-corp customer hit today's $50 limit").
// Source distinguishes local-advisory vs backend-authoritative throws so
// observability / tests can tell which path produced the throw (§2a D3,
// I-T3-2).

import {
  PYLVA_BUDGET_EXCEEDED_CODE,
  BudgetExceededSource,
  type BudgetExceededSource as BudgetExceededSourceType,
} from '@pylva/shared';

export interface PylvaBudgetExceededInit {
  source: BudgetExceededSourceType;
  rule_id: string;
  customer_id: string | null;
  period: 'hour' | 'day' | 'week' | 'month';
  period_start: string; // ISO 8601
  limit_usd: number;
  accumulated_usd: number;
  estimated_usd: number; // 0 when we can't estimate (e.g. report_usage)
}

export class PylvaBudgetExceeded extends Error {
  readonly code = PYLVA_BUDGET_EXCEEDED_CODE;
  readonly source: BudgetExceededSourceType;
  readonly rule_id: string;
  readonly customer_id: string | null;
  readonly period: 'hour' | 'day' | 'week' | 'month';
  readonly period_start: string;
  readonly limit_usd: number;
  readonly accumulated_usd: number;
  readonly estimated_usd: number;

  constructor(init: PylvaBudgetExceededInit) {
    const msg = formatMessage(init);
    super(msg);
    this.name = 'PylvaBudgetExceeded';
    this.source = init.source;
    this.rule_id = init.rule_id;
    this.customer_id = init.customer_id;
    this.period = init.period;
    this.period_start = init.period_start;
    this.limit_usd = init.limit_usd;
    this.accumulated_usd = init.accumulated_usd;
    this.estimated_usd = init.estimated_usd;
  }
}

function formatMessage(init: PylvaBudgetExceededInit): string {
  const who = init.customer_id ?? 'pooled';
  const spend = (init.accumulated_usd + init.estimated_usd).toFixed(2);
  return `[pylva] budget exceeded for ${who} (${init.period}): $${spend} ≥ $${init.limit_usd.toFixed(2)} (source=${init.source}, rule=${init.rule_id})`;
}

// Re-export the shared source enum so consumers don't need two imports.
export { BudgetExceededSource };
