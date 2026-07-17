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
} from '@pylva/shared/budget-errors';

export interface AuthoritativeBudgetRuleSnapshot {
  ruleId: string;
  scope: 'per_customer' | 'pooled';
  customerId: string | null;
  period: 'hour' | 'day' | 'week' | 'month';
  periodStart: string;
  periodEnd: string;
}

export interface AuthoritativeBudgetWarning {
  code: 'advisory_budget_exceeded';
  ruleId: string;
  limitUsd: string;
  projectedUsd: string;
}

/**
 * Exact, schema-validated denial evidence from authoritative control.
 *
 * The legacy numeric fields on `PylvaBudgetExceeded` remain available for
 * compatibility. This additive object preserves every exact decimal string
 * so callers never have to rely on a binary floating-point projection.
 */
export interface AuthoritativeBudgetDenial {
  schemaVersion: '1.0';
  decision: 'denied';
  allowed: false;
  decisionId: string;
  operationId: string;
  state: 'refused';
  decidingRule: AuthoritativeBudgetRuleSnapshot;
  committedUsd: string;
  reservedUsd: string;
  unresolvedUsd: string;
  requestedUsd: string;
  limitUsd: string;
  remainingUsd: string;
  warnings: AuthoritativeBudgetWarning[];
}

export interface PylvaBudgetExceededInit {
  source: BudgetExceededSourceType;
  rule_id: string;
  customer_id: string | null;
  period: 'hour' | 'day' | 'week' | 'month';
  period_start: string; // ISO 8601
  limit_usd: number;
  accumulated_usd: number;
  estimated_usd: number; // 0 when we can't estimate (e.g. report_usage)
  authoritativeDenial?: AuthoritativeBudgetDenial;
}

export interface PylvaBudgetExceeded extends Error {
  readonly code: typeof PYLVA_BUDGET_EXCEEDED_CODE;
  readonly source: BudgetExceededSourceType;
  readonly rule_id: string;
  readonly customer_id: string | null;
  readonly period: 'hour' | 'day' | 'week' | 'month';
  readonly period_start: string;
  readonly limit_usd: number;
  readonly accumulated_usd: number;
  readonly estimated_usd: number;
  readonly authoritativeDenial: AuthoritativeBudgetDenial | undefined;
}

interface PylvaBudgetExceededConstructor extends Function {
  new (init: PylvaBudgetExceededInit): PylvaBudgetExceeded;
  readonly prototype: PylvaBudgetExceeded;
}

// The published package routes every entrypoint through one physical error
// module, so ordinary module identity provides the cross-format constructor.
export const PylvaBudgetExceeded = class PylvaBudgetExceeded
  extends Error
  implements PylvaBudgetExceeded
{
  readonly code = PYLVA_BUDGET_EXCEEDED_CODE;
  declare readonly source: BudgetExceededSourceType;
  declare readonly rule_id: string;
  declare readonly customer_id: string | null;
  declare readonly period: 'hour' | 'day' | 'week' | 'month';
  declare readonly period_start: string;
  declare readonly limit_usd: number;
  declare readonly accumulated_usd: number;
  declare readonly estimated_usd: number;
  declare readonly authoritativeDenial: AuthoritativeBudgetDenial | undefined;

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
    this.authoritativeDenial = init.authoritativeDenial;
  }
} as PylvaBudgetExceededConstructor;
Object.defineProperty(PylvaBudgetExceeded, 'name', { value: 'PylvaBudgetExceeded' });

function formatMessage(init: PylvaBudgetExceededInit): string {
  const who = init.customer_id ?? 'pooled';
  const spend = (init.accumulated_usd + init.estimated_usd).toFixed(2);
  return `[pylva] budget exceeded for ${who} (${init.period}): $${spend} ≥ $${init.limit_usd.toFixed(2)} (source=${init.source}, rule=${init.rule_id})`;
}

// Re-export the shared source enum so consumers don't need two imports.
export { BudgetExceededSource };
