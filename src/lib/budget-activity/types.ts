export const BUDGET_ACTIVITY_STATUSES = [
  'reserved',
  'charged',
  'released',
  'unresolved',
  'refused',
] as const;

export type BudgetActivityStatus = (typeof BUDGET_ACTIVITY_STATUSES)[number];
export type BudgetActivityKind = 'llm' | 'tool';
export type ProviderRequestState = 'not_sent' | 'sent' | 'not_confirmed';

export interface BudgetActivityAllocation {
  account_id: string;
  rule_key: string;
  rule_name: string | null;
  rule_revision_id: string;
  rule_revision: string;
  scope: 'pooled' | 'per_customer';
  subject_customer_id: string | null;
  period: 'hour' | 'day' | 'week' | 'month';
  period_start: string;
  period_end: string;
  enforcement: 'hard_stop' | 'advisory';
  status: 'reserved' | 'refused' | 'not_held' | 'shadow' | 'committed' | 'released' | 'unresolved';
  evaluation_order: number;
  is_deciding: boolean;
  committed_before_usd: string;
  reserved_before_usd: string;
  unresolved_before_usd: string;
  requested_usd: string;
  projected_usd: string;
  limit_usd: string;
  remaining_usd: string;
  current_committed_usd: string;
  current_reserved_usd: string;
  current_unresolved_usd: string;
}

export interface BudgetActivity {
  decision_id: string;
  reservation_id: string | null;
  operation_id: string;
  status: BudgetActivityStatus;
  activity_at: string;
  customer_id: string;
  kind: BudgetActivityKind;
  source: string;
  provider: string | null;
  model: string | null;
  cost_source_slug: string | null;
  tool_name: string | null;
  metric: string | null;
  maximum_value: string | null;
  step_name: string | null;
  framework: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  requested_usd: string | null;
  reserved_usd: string;
  actual_usd: string;
  released_usd: string;
  overage_usd: string;
  remaining_usd: string | null;
  reason: string;
  provider_request: ProviderRequestState;
  cost_event_id: string | null;
  allocations: BudgetActivityAllocation[];
}

export interface BudgetActivityQuery {
  status: BudgetActivityStatus | 'all';
  kind: BudgetActivityKind | 'all';
  customer: string | null;
  source: string | null;
  trace_id: string | null;
  rule_key: string | null;
  page: number;
  page_size: number;
}

export interface BudgetActivityPage {
  activities: BudgetActivity[];
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
  };
  filters: BudgetActivityQuery;
  authority: 'postgresql';
}

export interface BudgetAccountState {
  account_id: string;
  rule_key: string;
  rule_name: string | null;
  scope: 'pooled' | 'per_customer';
  subject_customer_id: string | null;
  period: 'hour' | 'day' | 'week' | 'month';
  period_start: string;
  period_end: string;
  enforcement: 'hard_stop' | 'advisory';
  limit_usd: string;
  committed_usd: string;
  reserved_usd: string;
  unresolved_usd: string;
  available_usd: string;
  is_current: boolean;
}

export interface BudgetAccountStateScope {
  customer_id?: string;
  trace_id?: string;
  rule_key?: string;
  limit?: number;
}
