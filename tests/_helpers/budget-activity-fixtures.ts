import type {
  BudgetAccountState,
  BudgetActivity,
  BudgetActivityPage,
} from '../../src/lib/budget-activity/types.js';

export const BUDGET_FIXTURE_IDS = {
  builder: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  decision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  reservation: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operation: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  trace: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  span: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  account: '11111111-1111-4111-8111-111111111111',
  rule: '22222222-2222-4222-8222-222222222222',
  revision: '33333333-3333-4333-8333-333333333333',
  costEvent: '44444444-4444-4444-8444-444444444444',
} as const;

export function budgetActivity(overrides: Partial<BudgetActivity> = {}): BudgetActivity {
  const status = overrides.status ?? 'refused';
  return {
    decision_id: BUDGET_FIXTURE_IDS.decision,
    reservation_id: status === 'refused' ? null : BUDGET_FIXTURE_IDS.reservation,
    operation_id: BUDGET_FIXTURE_IDS.operation,
    status,
    activity_at: '2026-07-14T09:30:00.000Z',
    customer_id: 'end_user_42',
    kind: 'llm',
    source: 'openai / gpt-4o-mini',
    provider: 'openai',
    model: 'gpt-4o-mini',
    cost_source_slug: null,
    tool_name: null,
    metric: null,
    maximum_value: null,
    step_name: 'answer_question',
    framework: 'langgraph',
    trace_id: BUDGET_FIXTURE_IDS.trace,
    span_id: BUDGET_FIXTURE_IDS.span,
    parent_span_id: null,
    requested_usd: '0.0000042',
    reserved_usd: status === 'refused' ? '0' : '0.0000042',
    actual_usd: status === 'charged' ? '0.0000031' : '0',
    released_usd: '0',
    overage_usd: '0',
    remaining_usd: '0.25',
    reason: status === 'refused' ? 'budget_exceeded' : 'provider usage charged',
    provider_request:
      status === 'refused' ? 'not_sent' : status === 'charged' ? 'sent' : 'not_confirmed',
    cost_event_id: status === 'charged' ? BUDGET_FIXTURE_IDS.costEvent : null,
    allocations: [
      {
        account_id: BUDGET_FIXTURE_IDS.account,
        rule_key: BUDGET_FIXTURE_IDS.rule,
        rule_name: 'Daily support budget',
        rule_revision_id: BUDGET_FIXTURE_IDS.revision,
        rule_revision: '2',
        scope: 'per_customer',
        subject_customer_id: 'end_user_42',
        period: 'day',
        period_start: '2026-07-14T00:00:00.000Z',
        period_end: '2026-07-15T00:00:00.000Z',
        enforcement: 'hard_stop',
        status: status === 'charged' ? 'committed' : status,
        evaluation_order: 0,
        is_deciding: status === 'refused',
        committed_before_usd: '0.74',
        reserved_before_usd: '0.01',
        unresolved_before_usd: '0',
        requested_usd: '0.0000042',
        projected_usd: '0.7500042',
        limit_usd: '0.75',
        remaining_usd: '0',
        current_committed_usd: '0.74',
        current_reserved_usd: '0.01',
        current_unresolved_usd: '0',
      },
    ],
    ...overrides,
  };
}

export function budgetActivityPage(
  activities: BudgetActivity[] = [budgetActivity()],
): BudgetActivityPage {
  return {
    activities,
    pagination: {
      page: 1,
      page_size: 25,
      total: activities.length,
      total_pages: activities.length === 0 ? 0 : 1,
    },
    filters: {
      status: 'all',
      kind: 'all',
      customer: null,
      source: null,
      trace_id: null,
      rule_key: null,
      page: 1,
      page_size: 25,
    },
    authority: 'postgresql',
  };
}

export function budgetAccountState(
  overrides: Partial<BudgetAccountState> = {},
): BudgetAccountState {
  return {
    account_id: BUDGET_FIXTURE_IDS.account,
    rule_key: BUDGET_FIXTURE_IDS.rule,
    rule_name: 'Daily support budget',
    scope: 'per_customer',
    subject_customer_id: 'end_user_42',
    period: 'day',
    period_start: '2026-07-14T00:00:00.000Z',
    period_end: '2026-07-15T00:00:00.000Z',
    enforcement: 'hard_stop',
    limit_usd: '0.75',
    committed_usd: '0.74',
    reserved_usd: '0.01',
    unresolved_usd: '0',
    available_usd: '0',
    is_current: true,
    ...overrides,
  };
}
