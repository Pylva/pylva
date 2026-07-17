// B4-1 rule preview / impact summary. Synchronous read-only analysis over
// the last 30 days of cost_events, scoped by the rule's match criteria.
// Used by:
//   - POST /api/v1/rules/{id}/preview — explicit dry-run from the dashboard
//   - POST /api/v1/rules/{id}/activate — inline before flipping status
//
// Returns the top-20 customers / steps / models the rule would touch, plus
// a human-readable description tailored per rule type. Never mutates rule
// state; never reads rules.config beyond the typed config shapes already
// validated by the validator at write time.

import {
  RuleType,
  type ModelRoutingConfig,
  type ReliabilityFailoverConfig,
  type Rule,
  type RuleType as RuleTypeType,
} from '@pylva/shared';
import { queryCostEvents } from '../clickhouse/client.js';
import { chTimestamp } from '../clickhouse/datetime.js';
import { extractExternalCustomerId } from '../clickhouse/customer-id.js';
import { formatUsd } from '../formatting.js';
import { affectsLiveTraffic } from './categories.js';

const TOP_N = 20;
const LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AffectedCustomer {
  customer_id: string;
  event_count: number;
  total_cost_usd: number;
}

export interface AffectedStep {
  step_name: string | null;
  event_count: number;
}

export interface AffectedModel {
  provider: string | null;
  model: string | null;
  event_count: number;
}

export interface RulePreview {
  rule_id: string;
  rule_type: RuleTypeType;
  range: { from: string; to: string }; // ISO 8601
  affected_customers: AffectedCustomer[];
  affected_steps: AffectedStep[];
  affected_models: AffectedModel[];
  // Track 3 PR 3.2 (O26) impact_pct = matched / total:
  //   matched_customers — distinct customers the rule's filters touch in
  //   the window (the numerator; NOT capped at TOP_N like the
  //   affected_customers sample list, which silently floored impact at
  //   20/N for large builders and kept the >=50% warning from ever firing).
  matched_customers: number;
  //   total_customers — distinct customers with any real traffic in the
  //   window, regardless of the rule's filters (the denominator).
  total_customers: number;
  total_event_count: number;
  total_cost_usd: number;
  description: string; // human-readable summary for impact card
  warnings: string[];
  live_traffic_warning: boolean; // true when activating would affect inflight SDK calls
}

interface CHCustomerRow {
  customer_id: string;
  event_count: string;
  total_cost_usd: string;
}

interface CHStepRow {
  step_name: string | null;
  event_count: string;
}

interface CHModelRow {
  provider: string | null;
  model: string | null;
  event_count: string;
}

interface CHTotalRow {
  total_event_count: string;
  total_cost_usd: string;
  matched_customers?: string;
}

function effectiveModelRoutingCustomer(rule: Rule, cfg: ModelRoutingConfig): string | null {
  return rule.customer_id ?? cfg.match.customer_id ?? null;
}

function describeCustomerSelector(customerId: string): string {
  return customerId === '' ? 'customer ""' : `customer ${customerId}`;
}

// Build the WHERE clause + parameters for the rule's match criteria. Returns
// only filters that ClickHouse can apply server-side; rule-type-specific
// post-processing (e.g. error-rate threshold for failover) is layered on
// top by the caller.
function buildScopeFilter(rule: Rule): { sql: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const clauses: string[] = [];

  if (rule.type === RuleType.MODEL_ROUTING) {
    const cfg = rule.config as unknown as ModelRoutingConfig;
    // Mirror the SDK engines: the rule-level customer_id wins over
    // config.match.customer_id, and preview/description must use that same
    // effective customer.
    const customerId = effectiveModelRoutingCustomer(rule, cfg);
    if (customerId !== null) {
      clauses.push('AND customer_id = {customer_id:String}');
      params['customer_id'] = `${rule.builder_id}:${customerId}`;
    }
    if (cfg.match.step_name) {
      clauses.push('AND step_name = {match_step:String}');
      params['match_step'] = cfg.match.step_name;
    }
    if (cfg.match.provider) {
      clauses.push('AND provider = {match_provider:String}');
      params['match_provider'] = cfg.match.provider;
    }
    if (cfg.match.model) {
      clauses.push('AND model = {match_model:String}');
      params['match_model'] = cfg.match.model;
    }
  } else if (rule.type !== RuleType.RELIABILITY_FAILOVER) {
    if (rule.customer_id) {
      clauses.push('AND customer_id = {customer_id:String}');
      params['customer_id'] = `${rule.builder_id}:${rule.customer_id}`;
    }
  }

  // Failover is scoped solely by config.customer_id below, mirroring the SDK
  // apply path (findFailoverRule matches on cfg.customer_id only and ignores
  // the rule-level customer_id column). The else branch above is skipped for
  // failover so we never AND two `customer_id =` predicates: when the column
  // and config customer differ — both are independently settable via
  // baseMeta + reliabilityFailoverConfig — that contradiction matches zero
  // rows, zeroing the activation impact_pct gate (apply≠preview divergence,
  // the same class fixed for model_routing in #262).
  if (rule.type === RuleType.RELIABILITY_FAILOVER) {
    const cfg = rule.config as unknown as ReliabilityFailoverConfig;
    clauses.push('AND customer_id = {failover_customer_id:String}');
    params['failover_customer_id'] = `${rule.builder_id}:${cfg.customer_id}`;
    clauses.push('AND provider = {primary:String}');
    params['primary'] = cfg.primary_provider;
  }

  return { sql: clauses.join(' '), params };
}

function describeRule(rule: Rule): string {
  switch (rule.type) {
    case RuleType.MODEL_ROUTING: {
      const cfg = rule.config as unknown as ModelRoutingConfig;
      const customerId = effectiveModelRoutingCustomer(rule, cfg);
      const matchParts = [
        customerId !== null && describeCustomerSelector(customerId),
        cfg.match.step_name && `step '${cfg.match.step_name}'`,
        cfg.match.provider && `provider ${cfg.match.provider}`,
        cfg.match.model && `model ${cfg.match.model}`,
      ]
        .filter(Boolean)
        .join(' + ');
      return `Route calls matching {${matchParts}} → ${cfg.route_to.provider}/${cfg.route_to.model}`;
    }
    case RuleType.RELIABILITY_FAILOVER: {
      const cfg = rule.config as unknown as ReliabilityFailoverConfig;
      return `When ${cfg.primary_provider} errors >${cfg.trigger_error_rate_pct}% for customer ${cfg.customer_id}, failover to ${cfg.backup_provider}.`;
    }
    case RuleType.BUDGET_LIMIT: {
      const cfg = rule.config as { limit_usd: number; period: string; hard_stop: boolean };
      const enforcement = cfg.hard_stop ? 'block at SDK pre-call' : 'alert post-call';
      return `Budget ${formatUsd(cfg.limit_usd)}/${cfg.period}, ${enforcement}.`;
    }
    case RuleType.COST_THRESHOLD: {
      const cfg = rule.config as { threshold_usd: number; period: string };
      return `Alert when spend exceeds ${formatUsd(cfg.threshold_usd)}/${cfg.period}.`;
    }
    case RuleType.MARGIN_PROTECTION: {
      const cfg = rule.config as { margin_threshold_pct: number; period: string };
      return `Alert when customer margin falls below ${cfg.margin_threshold_pct}%/${cfg.period}.`;
    }
  }
}

export async function previewRule(rule: Rule, now: Date = new Date()): Promise<RulePreview> {
  const from = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const range = { from: from.toISOString(), to: now.toISOString() };
  const scope = buildScopeFilter(rule);

  // is_demo = 0 mirrors the dashboard-queries default: previews compute
  // impact on REAL traffic, not seeded demo events.
  const baseWhere = `WHERE builder_id = {builder_id:String}
    AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
    AND is_demo = 0
    ${scope.sql}`;

  const params: Record<string, unknown> = {
    ...scope.params,
    from: chTimestamp(from),
    to: chTimestamp(now),
  };

  const [customerRows, stepRows, modelRows, totalRows, denominatorRows] = await Promise.all([
    queryCostEvents(
      rule.builder_id,
      `SELECT customer_id, count() AS event_count, sum(cost_usd) AS total_cost_usd
       FROM cost_events_with_control
       ${baseWhere}
       GROUP BY customer_id
       ORDER BY event_count DESC
       LIMIT ${TOP_N}`,
      params,
    ),
    queryCostEvents(
      rule.builder_id,
      `SELECT step_name, count() AS event_count
       FROM cost_events_with_control
       ${baseWhere}
       GROUP BY step_name
       ORDER BY event_count DESC
       LIMIT ${TOP_N}`,
      params,
    ),
    queryCostEvents(
      rule.builder_id,
      `SELECT provider, model, count() AS event_count
       FROM cost_events_with_control
       ${baseWhere}
       GROUP BY provider, model
       ORDER BY event_count DESC
       LIMIT ${TOP_N}`,
      params,
    ),
    queryCostEvents(
      rule.builder_id,
      // Track 3 PR 3.2 (O26): uniqExact over the SCOPED window — the true
      // numerator for impact_pct. The affected_customers list above is a
      // TOP_N display sample; using its length as the numerator floored
      // impact at 20/N for large builders (B11).
      `SELECT count() AS total_event_count,
              sum(cost_usd) AS total_cost_usd,
              uniqExact(customer_id) AS matched_customers
       FROM cost_events_with_control
       ${baseWhere}`,
      params,
    ),
    // Denominator: distinct customers with any real traffic in the window,
    // independent of the rule's filters. Skipped when the rule has no
    // filters (scoped == builder-wide).
    scope.sql.length > 0
      ? queryCostEvents(
          rule.builder_id,
          `SELECT uniqExact(customer_id) AS total_customers
           FROM cost_events_with_control
           WHERE builder_id = {builder_id:String}
             AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
             AND timestamp <= parseDateTime64BestEffort({to:String}, 3, 'UTC')
             AND is_demo = 0`,
          { from: params['from'], to: params['to'] },
        )
      : Promise.resolve(null),
  ]);

  const totals = (totalRows[0] as CHTotalRow | undefined) ?? {
    total_event_count: '0',
    total_cost_usd: '0',
  };
  const matchedCustomers = Number(totals.matched_customers ?? affectedCustomersLengthFallback());
  const totalCustomers = denominatorRows
    ? Number((denominatorRows[0] as { total_customers?: string } | undefined)?.total_customers ?? 0)
    : matchedCustomers;

  function affectedCustomersLengthFallback(): number {
    return (customerRows as CHCustomerRow[]).length;
  }

  const affectedCustomers: AffectedCustomer[] = (customerRows as CHCustomerRow[]).map((r) => ({
    customer_id: extractExternalCustomerId(r.customer_id, rule.builder_id),
    event_count: Number(r.event_count),
    total_cost_usd: Number(r.total_cost_usd ?? 0),
  }));

  const warnings: string[] = [];
  if (Number(totals.total_event_count) === 0) {
    warnings.push(
      'No events matched this rule in the last 30 days. Activate anyway only if you expect future traffic to match.',
    );
  }

  return {
    rule_id: rule.id,
    rule_type: rule.type,
    range,
    affected_customers: affectedCustomers,
    affected_steps: (stepRows as CHStepRow[]).map((r) => ({
      step_name: r.step_name,
      event_count: Number(r.event_count),
    })),
    affected_models: (modelRows as CHModelRow[]).map((r) => ({
      provider: r.provider,
      model: r.model,
      event_count: Number(r.event_count),
    })),
    matched_customers: matchedCustomers,
    total_customers: totalCustomers,
    total_event_count: Number(totals.total_event_count),
    total_cost_usd: Number(totals.total_cost_usd ?? 0),
    description: describeRule(rule),
    warnings,
    live_traffic_warning: affectsLiveTraffic(rule.type),
  };
}
