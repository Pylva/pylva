// B2a T3 — payload builder per rule type. Produces the WebhookPayload that
// flows through delivery.ts to every channel. The wire shape is shared with
// SDK consumers (verifyWebhook) via @pylva/shared.

import crypto from 'node:crypto';
import {
  WebhookEventType,
  type BudgetExceededPayload,
  type CostThresholdPayload,
  type MarginAlertPayload,
  type Rule,
  type WebhookPayload,
} from '@pylva/shared';

export interface PayloadContext {
  builder_id: string;
  customer_id: string | null; // null for pooled rules
  current_usd: number;
  period_start: string; // ISO
}

export function buildCostThresholdPayload(rule: Rule, ctx: PayloadContext): CostThresholdPayload {
  const cfg = rule.config as { threshold_usd: number; period: string };
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.COST_THRESHOLD_EXCEEDED,
    builder_id: ctx.builder_id,
    timestamp: new Date().toISOString(),
    data: {
      customer_id: ctx.customer_id,
      threshold_usd: cfg.threshold_usd,
      current_usd: ctx.current_usd,
      period: cfg.period,
      rule_id: rule.id,
    },
  };
}

export function buildBudgetExceededPayload(
  rule: Rule,
  ctx: PayloadContext,
  action: 'blocked' | 'warned',
): BudgetExceededPayload {
  const cfg = rule.config as { limit_usd: number };
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.BUDGET_EXCEEDED,
    builder_id: ctx.builder_id,
    timestamp: new Date().toISOString(),
    data: {
      customer_id: ctx.customer_id,
      budget_usd: cfg.limit_usd,
      current_usd: ctx.current_usd,
      action_taken: action,
      rule_id: rule.id,
    },
  };
}

export function buildMarginAlertPayload(
  rule: Rule,
  ctx: PayloadContext & {
    margin_percent: number;
    top_drivers: Array<{ label: string; cost_usd: number }>;
  },
): MarginAlertPayload {
  const cfg = rule.config as { margin_threshold_pct: number };
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.MARGIN_ALERT,
    builder_id: ctx.builder_id,
    timestamp: new Date().toISOString(),
    data: {
      customer_id: ctx.customer_id,
      margin_percent: ctx.margin_percent,
      threshold_percent: cfg.margin_threshold_pct,
      diagnosis: { top_drivers: ctx.top_drivers },
    },
  };
}

// Dispatcher — picks the right builder based on rule.type. margin_protection
// needs diagnosis extras, so callers compose manually for that.
export function buildPayloadForRule(rule: Rule, ctx: PayloadContext): WebhookPayload {
  switch (rule.type) {
    case 'cost_threshold':
      return buildCostThresholdPayload(rule, ctx);
    case 'budget_limit': {
      const cfg = rule.config as { hard_stop?: boolean };
      return buildBudgetExceededPayload(rule, ctx, cfg.hard_stop ? 'blocked' : 'warned');
    }
    case 'margin_protection':
      // Callers compose directly via buildMarginAlertPayload so they can inject
      // margin_percent + top_drivers from the diagnosis query.
      throw new Error('[alerts.payloads] margin_protection uses buildMarginAlertPayload directly');
    default:
      throw new Error(`[alerts.payloads] unsupported rule type: ${rule.type}`);
  }
}
