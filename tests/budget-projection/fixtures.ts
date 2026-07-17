import type { AuthoritativeBudgetCostEventPayload } from '../../src/lib/budget-projection/contracts.js';
import type {
  BudgetProjectionLease,
  BudgetProjectionStatus,
} from '../../src/lib/budget-projection/postgres.js';

export const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
export const EVENT_ID = '22222222-2222-4222-8222-222222222222';
export const OUTBOX_ID = '33333333-3333-4333-8333-333333333333';
export const DECISION_ID = '44444444-4444-4444-8444-444444444444';
export const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
export const TRACE_ID = '66666666-6666-4666-8666-666666666666';
export const SPAN_ID = '77777777-7777-4777-8777-777777777777';
export const PAYLOAD_HASH = 'a'.repeat(64);
export const WORKER_ID = 'budget-projection:88888888-8888-4888-8888-888888888888';

export function toolPayload(
  overrides: Partial<AuthoritativeBudgetCostEventPayload> = {},
): AuthoritativeBudgetCostEventPayload {
  return {
    schema_version: '1.6',
    event_id: EVENT_ID,
    timestamp: '2026-07-14T09:10:11.123Z',
    builder_id: BUILDER_ID,
    reservation_decision_id: DECISION_ID,
    operation_id: OPERATION_ID,
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    parent_span_id: null,
    customer_id: `${BUILDER_ID}:customer_1`,
    provider: 'other',
    model: null,
    operation: 'reported',
    step_name: 'agent.search',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: '0.001234567890123456',
    pricing_status: 'priced',
    latency_ms: 25,
    status: 'success',
    cost_source: 'configured',
    instrumentation_tier: 'reported',
    metric: 'credit',
    metric_value: '1',
    stream_aborted: false,
    abort_savings: '0',
    is_demo: false,
    retention_days: 365,
    billing_retention_days: 2_555,
    metadata: {
      framework: 'langgraph',
      sdk_language: 'typescript',
      sdk_version: '1.2.0',
      tool_name: 'tavily_search',
      cost_source_slug: 'tavily-search',
      pricing_snapshot_hash: 'b'.repeat(64),
      usage_snapshot_hash: 'c'.repeat(64),
    },
    ...overrides,
  };
}

export function llmPayload(
  overrides: Partial<AuthoritativeBudgetCostEventPayload> = {},
): AuthoritativeBudgetCostEventPayload {
  return {
    ...toolPayload(),
    provider: 'openai',
    model: 'gpt-4o-mini',
    operation: 'chat.completions',
    tokens_in: 100,
    tokens_out: 25,
    cost_source: 'auto',
    instrumentation_tier: 'sdk_wrapper',
    metric: null,
    metric_value: null,
    metadata: {
      token_count_source: 'exact',
      framework: 'langgraph',
      sdk_language: 'typescript',
      sdk_version: '1.2.0',
      pricing_snapshot_hash: 'b'.repeat(64),
      usage_snapshot_hash: 'c'.repeat(64),
    },
    ...overrides,
  };
}

export function projectionLease(
  overrides: Partial<BudgetProjectionLease> = {},
): BudgetProjectionLease {
  return {
    builder_id: BUILDER_ID,
    outbox_id: OUTBOX_ID,
    event_id: EVENT_ID,
    payload_hash: PAYLOAD_HASH,
    payload: toolPayload(),
    attempt: 1,
    worker_id: WORKER_ID,
    locked_at: '2026-07-14T09:10:12.000Z',
    lock_expires_at: '2026-07-14T09:11:12.000Z',
    ...overrides,
  };
}

export function projectionStatus(
  overrides: Partial<BudgetProjectionStatus> = {},
): BudgetProjectionStatus {
  return {
    pending: 0,
    processing: 0,
    projected_unverified: 0,
    projected_verified: 0,
    high_attempt_rows: 0,
    exhausted_attempt_rows: 0,
    oldest_pending_at: null,
    oldest_unverified_event_at: null,
    latest_authoritative_event_at: null,
    contiguous_verified_before: null,
    caught_up: true,
    ...overrides,
  };
}
