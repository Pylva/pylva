import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetBypassReason,
  BudgetUnavailableReason,
  ReserveUsageRequestSchema,
  ReserveUsageResponseSchema,
  type ParsedReserveUsageRequest,
  type ReserveUsageResponse,
} from '@pylva/shared';
import * as v from 'valibot';
import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';

const accountMocks = vi.hoisted(() => ({ ensureBudgetAccountsMaterialized: vi.fn() }));

// Orchestration tests inject every database-facing seam. Avoid constructing
// the production pool (and therefore requiring application env) at import time.
vi.mock('../../src/lib/db/client.js', () => ({ sql: {} }));
vi.mock('../../src/lib/budget-control/accounts.js', () => ({
  ensureBudgetAccountsMaterialized: accountMocks.ensureBudgetAccountsMaterialized,
}));

import {
  BudgetAccountMaterializationUnavailableError,
  BudgetIdempotencyConflictError,
  canonicalReserveRequestSnapshot,
  createReserveBudgetUsage,
} from '../../src/lib/budget-control/reservation-service.js';

const BUILDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = '22222222-2222-4222-8222-222222222222';
const SPAN_ID = '33333333-3333-4333-8333-333333333333';
const DECISION_ID = '44444444-4444-4444-8444-444444444444';
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555';

function llmRequest(overrides: Partial<ParsedReserveUsageRequest> = {}): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: OPERATION_ID,
    customer_id: 'customer_1',
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
    parent_span_id: null,
    step_name: 'agent.call',
    kind: 'llm',
    provider: 'openai',
    model: 'gpt-4o-mini',
    estimated_input_tokens: 100,
    max_output_tokens: 50,
    ...overrides,
  });
}

function reservedResponse(request: ParsedReserveUsageRequest): ReserveUsageResponse {
  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: 'reserved',
    allowed: true,
    decision_id: DECISION_ID,
    operation_id: request.operation_id,
    reservation_id: RESERVATION_ID,
    state: 'reserved',
    reserved_usd: '0.01',
    remaining_usd: '0.99',
    expires_at: '2030-01-01T00:05:00.000Z',
    warnings: [],
  };
}

function persistentControlFailure(
  request: ParsedReserveUsageRequest,
  retryable = true,
): ReserveUsageResponse {
  return request.mode === 'shadow'
    ? {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        decision: 'bypassed',
        allowed: true,
        decision_id: DECISION_ID,
        operation_id: request.operation_id,
        reason: BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
        would_have_denied: null,
        warnings: [],
      }
    : {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        decision: 'unavailable',
        allowed: false,
        decision_id: DECISION_ID,
        operation_id: request.operation_id,
        reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
        retryable,
      };
}

describe('reservation service orchestration', () => {
  it('returns an outage-safe ephemeral bypass without touching dependencies when disabled', async () => {
    const ensureBudgetAccountsMaterialized = vi.fn();
    const authorizeAttempt = vi.fn();
    const persistControlFailure = vi.fn();
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => false,
      ensureBudgetAccountsMaterialized,
      authorizeAttempt,
      persistControlFailure,
    });
    const request = llmRequest();

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual({
      schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
      decision: 'bypassed',
      allowed: true,
      decision_id: null,
      operation_id: OPERATION_ID,
      reason: BudgetBypassReason.CONTROL_DISABLED,
      would_have_denied: null,
      warnings: [],
    });
    expect(ensureBudgetAccountsMaterialized).not.toHaveBeenCalled();
    expect(authorizeAttempt).not.toHaveBeenCalled();
    expect(persistControlFailure).not.toHaveBeenCalled();
  });

  it('builds the exact parsed/defaulted LLM hash snapshot including explicit nullable fields', () => {
    const request = llmRequest();

    expect(canonicalReserveRequestSnapshot(request)).toEqual({
      schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
      mode: 'enforce',
      operation_id: OPERATION_ID,
      customer_id: 'customer_1',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      parent_span_id: null,
      step_name: 'agent.call',
      framework: 'none',
      reservation_ttl_seconds: 300,
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-4o-mini',
      estimated_input_tokens: 100,
      max_output_tokens: 50,
    });
  });

  it('preserves canonical decimal tool bounds in the hash snapshot', () => {
    const request = v.parse(ReserveUsageRequestSchema, {
      schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
      mode: 'shadow',
      operation_id: OPERATION_ID,
      customer_id: 'customer_1',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      parent_span_id: null,
      step_name: null,
      kind: 'tool',
      cost_source_slug: 'tavily-search',
      tool_name: 'tavily_search',
      metric: 'credit',
      maximum_value: '10.5000',
    });

    expect(canonicalReserveRequestSnapshot(request)).toMatchObject({
      framework: 'none',
      reservation_ttl_seconds: 300,
      maximum_value: '10.5',
    });
  });

  it('finishes account preparation before authorization and forwards SDK identity', async () => {
    const order: string[] = [];
    const request = llmRequest();
    const ensureBudgetAccountsMaterialized = vi.fn(async () => {
      order.push('materialize');
    });
    const authorizeAttempt = vi.fn(async () => {
      order.push('authorize');
      return reservedResponse(request);
    });
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized,
      authorizeAttempt,
    });

    await expect(
      reserve(BUILDER_ID, request, {
        sdkLanguage: 'typescript',
        sdkVersion: '1.2.0',
      }),
    ).resolves.toEqual(reservedResponse(request));
    expect(order).toEqual(['materialize', 'authorize']);
    expect(ensureBudgetAccountsMaterialized).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      customerId: 'customer_1',
    });
    expect(authorizeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        builderId: BUILDER_ID,
        request,
        sdkIdentity: { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
      }),
    );
  });

  it.each([
    [{ code: '40001', message: 'serialization failure' }, 5],
    [{ code: '40P01', message: 'deadlock detected' }, 5],
    [
      {
        code: '23514',
        message: 'reserved lifecycle requires matching allocation settlement',
      },
      5,
    ],
    [
      {
        code: '57014',
        message: 'reservation lease expired before authorization could commit',
      },
      5,
    ],
  ])('retries only a classified fresh-transaction failure %#', async (error, expectedDelay) => {
    const request = llmRequest();
    const ensureBudgetAccountsMaterialized = vi.fn(async () => undefined);
    const authorizeAttempt = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(reservedResponse(request));
    const sleep = vi.fn(async () => undefined);
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized,
      authorizeAttempt,
      sleep,
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(reservedResponse(request));
    expect(ensureBudgetAccountsMaterialized).toHaveBeenCalledTimes(2);
    expect(authorizeAttempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(expectedDelay);
  });

  it('does not retry an unrelated PostgreSQL constraint failure', async () => {
    const request = llmRequest();
    const ensureBudgetAccountsMaterialized = vi.fn(async () => undefined);
    const authorizeAttempt = vi.fn(async () => {
      throw { code: '23514', message: 'some unrelated constraint failure' };
    });
    const persistControlFailure = vi.fn(async () => persistentControlFailure(request));
    const sleep = vi.fn();
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized,
      authorizeAttempt,
      persistControlFailure,
      sleep,
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(persistentControlFailure(request));
    expect(ensureBudgetAccountsMaterialized).toHaveBeenCalledTimes(1);
    expect(authorizeAttempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('persists fail-closed after bounded classified retries are exhausted', async () => {
    const request = llmRequest();
    const ensureBudgetAccountsMaterialized = vi.fn(async () => undefined);
    const authorizeAttempt = vi.fn(async () => {
      throw { code: '40001', message: 'serialization failure' };
    });
    const persistControlFailure = vi.fn(async () => persistentControlFailure(request));
    const sleep = vi.fn(async () => undefined);
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized,
      authorizeAttempt,
      persistControlFailure,
      sleep,
      maxAttempts: 3,
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(persistentControlFailure(request));
    expect(ensureBudgetAccountsMaterialized).toHaveBeenCalledTimes(3);
    expect(authorizeAttempt).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5], [20]]);
  });

  it('surfaces a canonical-body conflict without retrying or overwriting it', async () => {
    const request = llmRequest();
    const conflict = new BudgetIdempotencyConflictError();
    const persistControlFailure = vi.fn();
    const authorizeAttempt = vi.fn(async () => {
      throw conflict;
    });
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized: async () => undefined,
      authorizeAttempt,
      persistControlFailure,
    });

    await expect(reserve(BUILDER_ID, request)).rejects.toBe(conflict);
    expect(authorizeAttempt).toHaveBeenCalledTimes(1);
    expect(persistControlFailure).not.toHaveBeenCalled();
  });

  it('uses the production account materializer before authorization by default', async () => {
    const request = llmRequest();
    accountMocks.ensureBudgetAccountsMaterialized.mockResolvedValueOnce({});
    const authorizeAttempt = vi.fn(async () => reservedResponse(request));
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      authorizeAttempt,
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(reservedResponse(request));
    expect(accountMocks.ensureBudgetAccountsMaterialized).toHaveBeenCalledWith({
      builderId: BUILDER_ID,
      customerId: 'customer_1',
    });
    expect(authorizeAttempt).toHaveBeenCalledTimes(1);
  });

  it('forwards the injected PostgreSQL client through the production materializer path', async () => {
    const request = llmRequest();
    const client = {} as Sql;
    accountMocks.ensureBudgetAccountsMaterialized.mockResolvedValueOnce({});
    const reserve = createReserveBudgetUsage({
      client,
      controlEnabled: () => true,
      authorizeAttempt: async () => reservedResponse(request),
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(reservedResponse(request));
    expect(accountMocks.ensureBudgetAccountsMaterialized).toHaveBeenCalledWith(
      { builderId: BUILDER_ID, customerId: 'customer_1' },
      { client },
    );
  });

  it('persists a deterministic materialization failure as non-retryable', async () => {
    const request = llmRequest();
    const persistControlFailure = vi.fn(async (input: { controlFailureRetryable?: boolean }) =>
      persistentControlFailure(request, input.controlFailureRetryable),
    );
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized: async () => {
        throw new BudgetAccountMaterializationUnavailableError('opening evidence missing', false);
      },
      authorizeAttempt: vi.fn(),
      persistControlFailure,
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(
      persistentControlFailure(request, false),
    );
    expect(persistControlFailure).toHaveBeenCalledWith(
      expect.objectContaining({ controlFailureRetryable: false }),
    );
  });

  it('keeps an untyped operational materialization failure retryable for a new operation', async () => {
    const request = llmRequest();
    const persistControlFailure = vi.fn(async (input: { controlFailureRetryable?: boolean }) =>
      persistentControlFailure(request, input.controlFailureRetryable),
    );
    const reserve = createReserveBudgetUsage({
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized: async () => {
        throw new Error('database connection unavailable');
      },
      persistControlFailure,
    });

    await expect(reserve(BUILDER_ID, request)).resolves.toEqual(
      persistentControlFailure(request, true),
    );
    expect(persistControlFailure).toHaveBeenCalledWith(
      expect.objectContaining({ controlFailureRetryable: true }),
    );
  });

  it.each(['enforce', 'shadow'] as const)(
    'returns a contract-valid ephemeral %s result only when durable failure persistence also fails',
    async (mode) => {
      const request = llmRequest({ mode });
      const reserve = createReserveBudgetUsage({
        controlEnabled: () => true,
        ensureBudgetAccountsMaterialized: async () => {
          throw new Error('database unavailable');
        },
        persistControlFailure: async () => {
          throw new Error('database unavailable');
        },
        randomUUID: () => DECISION_ID,
      });

      const result = await reserve(BUILDER_ID, request);
      expect(v.safeParse(ReserveUsageResponseSchema, result).success).toBe(true);
      if (mode === 'enforce') {
        expect(result).toMatchObject({
          decision: 'unavailable',
          allowed: false,
          decision_id: null,
          reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          retryable: true,
        });
      } else {
        expect(result).toMatchObject({
          decision: 'bypassed',
          allowed: true,
          decision_id: null,
          reason: BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
          would_have_denied: null,
        });
      }
    },
  );

  it.each([0, 6, 1.5, Number.NaN])('rejects an unsafe retry attempt cap: %s', (maxAttempts) => {
    expect(() => createReserveBudgetUsage({ maxAttempts })).toThrow(RangeError);
  });
});
