// Real-time WebSocket feed types — spec Section 4.13

export interface CostUpdateMessage {
  type: 'cost_update';
  data: {
    customer_id: string;
    cost_usd: number;
    model: string | null;
    provider: string | null;
    step_name: string | null;
    timestamp: string; // ISO 8601
  };
}

export interface BudgetAlertMessage {
  type: 'budget_alert';
  data: {
    customer_id: string;
    budget_usd: number;
    current_usd: number;
    percent_used: number;
    rule_id: string;
  };
}

export interface RuleTriggeredMessage {
  type: 'rule_triggered';
  data: {
    rule_id: string;
    rule_type: string;
    customer_id: string;
    action_taken: string;
    details: Record<string, unknown>;
  };
}

export type WsFeedMessage = CostUpdateMessage | BudgetAlertMessage | RuleTriggeredMessage;

// B3-T2 (D per spec §4.2): forward-compatible alias — the transport is SSE,
// not WebSocket. Existing WsFeedMessage callers keep working; new code should
// prefer SseFeedMessage. Full rename deferred (spec §14 deferred items).
export type SseFeedMessage = WsFeedMessage;
