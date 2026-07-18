import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfigForTests, init } from '../src/core/config.js';
import {
  _resetControlClientForTests,
  reserveUsage,
  type ReserveUsageInput,
} from '../src/core/control_client.js';
import { PylvaBudgetExceeded } from '../src/errors/budget_exceeded.js';
import {
  PylvaControlApiError,
  PylvaControlUnavailableError,
  PylvaControlValidationError,
} from '../src/errors/control.js';

const KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TRACE_ID = '22222222-2222-4222-8222-222222222222';
const SPAN_ID = '33333333-3333-4333-8333-333333333333';
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444';
const DECISION_ID = '55555555-5555-4555-8555-555555555555';
const RULE_ID = '66666666-6666-4666-8666-666666666666';

const capabilities = {
  schema_version: '1.0',
  control_enabled: true,
  min_reservation_ttl_seconds: 30,
  default_reservation_ttl_seconds: 300,
  max_reservation_ttl_seconds: 3600,
  server_time: '2026-07-14T09:00:00.000Z',
};

const reserved = {
  schema_version: '1.0',
  decision: 'reserved',
  allowed: true,
  decision_id: DECISION_ID,
  operation_id: OPERATION_ID,
  reservation_id: RESERVATION_ID,
  state: 'reserved',
  reserved_usd: '0.125',
  remaining_usd: '9.875',
  expires_at: '2026-07-14T09:05:00.000Z',
  warnings: [],
};

const unavailable = {
  schema_version: '1.0',
  decision: 'unavailable',
  allowed: false,
  decision_id: null,
  operation_id: OPERATION_ID,
  reason: 'pricing_unavailable',
  retryable: false,
};

const pooledDenial = {
  schema_version: '1.0',
  decision: 'denied',
  allowed: false,
  decision_id: DECISION_ID,
  operation_id: OPERATION_ID,
  state: 'refused',
  deciding_rule: {
    rule_id: RULE_ID,
    scope: 'pooled',
    customer_id: null,
    period: 'day',
    period_start: '2026-07-14T00:00:00.000Z',
    period_end: '2026-07-15T00:00:00.000Z',
  },
  committed_usd: '2.1',
  reserved_usd: '3.2',
  unresolved_usd: '0.7',
  requested_usd: '5',
  limit_usd: '10',
  remaining_usd: '4',
  warnings: [],
};

function llmInput(overrides: Partial<ReserveUsageInput> = {}): ReserveUsageInput {
  return {
    kind: 'llm',
    operationId: OPERATION_ID,
    customerId: 'customer_acme',
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: null,
    stepName: 'answer',
    framework: 'langgraph',
    reservationTtlSeconds: 300,
    provider: 'openai',
    model: 'gpt-4.1',
    estimatedInputTokens: 200,
    maxOutputTokens: 500,
    ...overrides,
  } as ReserveUsageInput;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('reserveUsage authoritative control', () => {
  beforeEach(() => {
    _resetControlClientForTests();
    _resetConfigForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetControlClientForTests();
    _resetConfigForTests();
  });

  it('returns a schema-validated local control_disabled decision in legacy mode without I/O', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY });
    await expect(reserveUsage(llmInput())).resolves.toEqual({
      schemaVersion: '1.0',
      decision: 'bypassed',
      allowed: true,
      decisionId: null,
      operationId: OPERATION_ID,
      reason: 'control_disabled',
      wouldHaveDenied: null,
      warnings: [],
      local: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a strict snake_case LLM request with no content-bearing fields', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json({ ...reserved, future_response_field: 'ignored' }));
    init({ apiKey: KEY, endpoint: 'https://control.test/', control: { mode: 'enforce' } });

    await expect(reserveUsage(llmInput())).resolves.toEqual({
      schemaVersion: '1.0',
      decision: 'reserved',
      allowed: true,
      decisionId: DECISION_ID,
      operationId: OPERATION_ID,
      reservationId: RESERVATION_ID,
      state: 'reserved',
      reservedUsd: '0.125',
      remainingUsd: '9.875',
      expiresAt: '2026-07-14T09:05:00.000Z',
      warnings: [],
    });

    const [url, request] = fetchSpy.mock.calls[1]!;
    expect(url).toBe('https://control.test/api/v1/budget/reservations');
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      schema_version: '1.0',
      mode: 'enforce',
      operation_id: OPERATION_ID,
      customer_id: 'customer_acme',
      trace_id: TRACE_ID,
      span_id: SPAN_ID,
      parent_span_id: null,
      step_name: 'answer',
      framework: 'langgraph',
      reservation_ttl_seconds: 300,
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-4.1',
      estimated_input_tokens: 200,
      max_output_tokens: 500,
    });
    expect(Object.keys(body)).not.toEqual(
      expect.arrayContaining([
        'prompt',
        'completion',
        'messages',
        'input',
        'output',
        'tool_arguments',
      ]),
    );
    expect(new Headers(request?.headers).get('x-pylva-sdk-language')).toBe('typescript');
  });

  it('normalizes safe-integer tool bounds to exact decimal strings', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(reserved));
    init({ apiKey: KEY, control: { mode: 'shadow' } });
    await reserveUsage({
      kind: 'tool',
      operationId: OPERATION_ID,
      customerId: 'customer_acme',
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: null,
      costSourceSlug: 'web-search',
      toolName: 'web.search',
      metric: 'queries',
      maximumValue: 2,
    });
    const body = JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: 'shadow',
      kind: 'tool',
      framework: 'none',
      reservation_ttl_seconds: 300,
      maximum_value: '2',
    });
  });

  it.each([
    llmInput({ operationId: 'not-a-uuid' }),
    llmInput({ estimatedInputTokens: -1 }),
    llmInput({ maxOutputTokens: Number.NaN }),
    { ...llmInput(), unexpected: true },
    { ...llmInput(), parentSpanId: undefined },
    {
      kind: 'tool',
      operationId: OPERATION_ID,
      customerId: 'customer_acme',
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: null,
      costSourceSlug: 'web-search',
      toolName: 'web.search',
      metric: 'queries',
      maximumValue: 1.5,
    },
    {
      kind: 'tool',
      operationId: OPERATION_ID,
      customerId: 'customer_acme',
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      parentSpanId: null,
      costSourceSlug: 'web-search',
      toolName: 'web.search',
      metric: 'queries',
      maximumValue: '-1',
    },
  ])('rejects invalid or unknown facade values before fetch %#', async (value) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    init({ apiKey: KEY, control: { mode: 'legacy' } });
    await expect(reserveUsage(value as ReserveUsageInput)).rejects.toBeInstanceOf(
      PylvaControlValidationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an honest unavailable decision on transport failure under allow without retrying', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockRejectedValueOnce(new Error('private proxy details'));
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
    const result = await reserveUsage(llmInput());
    expect(result).toEqual({
      schemaVersion: '1.0',
      decision: 'unavailable',
      allowed: false,
      decisionId: null,
      operationId: OPERATION_ID,
      reason: 'control_unavailable',
      retryable: true,
      controlReason: 'network_error',
      local: true,
    });
    expect(JSON.stringify(result)).not.toContain('private proxy details');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('throws an explicit unavailable error with operation identity and exact evidence under deny', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockRejectedValueOnce(new Error('offline'));
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'deny' } });
    try {
      await reserveUsage(llmInput());
      expect.fail('reserveUsage should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PylvaControlUnavailableError);
      expect(error).toMatchObject({
        code: 'control_unavailable',
        reason: 'network_error',
        retryable: true,
        operation: 'reserveUsage',
        operationId: OPERATION_ID,
        reservationId: null,
        unavailableResponse: {
          schemaVersion: '1.0',
          decision: 'unavailable',
          allowed: false,
          operationId: OPERATION_ID,
          reason: 'control_unavailable',
        },
      });
    }
  });

  it('preserves a backend unavailable decision under allow and throws it under deny', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(unavailable));
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
    await expect(reserveUsage(llmInput())).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
      reason: 'pricing_unavailable',
      controlReason: 'pricing_unavailable',
      local: false,
    });

    _resetControlClientForTests();
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(unavailable));
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'deny' } });
    await expect(reserveUsage(llmInput())).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'pricing_unavailable',
      unavailableResponse: { reason: 'pricing_unavailable', allowed: false },
    });
  });

  it('returns an unavailable result for old/disabled capability under allow, never an allowed bypass', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 404 }));
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
    await expect(reserveUsage(llmInput())).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
      reason: 'control_unavailable',
      controlReason: 'unsupported_backend',
    });

    _resetControlClientForTests();
    vi.mocked(fetch).mockResolvedValueOnce(json({ ...capabilities, control_enabled: false }));
    await expect(reserveUsage(llmInput())).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
      controlReason: 'control_disabled',
    });
  });

  it.each([
    ['enforce', 'control_disabled', 'control_disabled', false],
    ['shadow', 'shadow_control_unavailable', 'control_unavailable', true],
  ] as const)(
    'does not leak a backend %s-mode %s availability bypass as budget approval',
    async (mode, reason, controlReason, retryable) => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json(capabilities))
        .mockResolvedValueOnce(
          json({
            schema_version: '1.0',
            decision: 'bypassed',
            allowed: true,
            decision_id: null,
            operation_id: OPERATION_ID,
            reason,
            would_have_denied: null,
            warnings: [],
          }),
        );
      init({ apiKey: KEY, control: { mode, onUnavailable: 'allow' } });
      await expect(reserveUsage(llmInput())).resolves.toMatchObject({
        decision: 'unavailable',
        allowed: false,
        reason: 'control_unavailable',
        controlReason,
        retryable,
        local: true,
      });
    },
  );

  it('applies deny when the backend disables control after readiness', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(
        json({
          schema_version: '1.0',
          decision: 'bypassed',
          allowed: true,
          decision_id: null,
          operation_id: OPERATION_ID,
          reason: 'control_disabled',
          would_have_denied: null,
          warnings: [],
        }),
      );
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'deny' } });
    await expect(reserveUsage(llmInput())).rejects.toMatchObject({
      name: 'PylvaControlUnavailableError',
      reason: 'control_disabled',
      unavailableResponse: { allowed: false, reason: 'control_unavailable' },
    });
  });

  it('turns an enforce denial into the existing budget error with additive exact evidence', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(pooledDenial));
    init({ apiKey: KEY, control: { mode: 'enforce' } });
    try {
      await reserveUsage(llmInput());
      expect.fail('reserveUsage should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PylvaBudgetExceeded);
      expect(error).toMatchObject({
        code: 'budget_exceeded',
        source: 'authoritative_control',
        rule_id: RULE_ID,
        customer_id: 'customer_acme',
        period: 'day',
        period_start: '2026-07-14T00:00:00.000Z',
        limit_usd: 10,
        accumulated_usd: 6,
        estimated_usd: 5,
        authoritativeDenial: {
          committedUsd: '2.1',
          reservedUsd: '3.2',
          unresolvedUsd: '0.7',
          requestedUsd: '5',
          limitUsd: '10',
          decidingRule: { scope: 'pooled', customerId: null },
        },
      });
    }
  });

  it('rejects an enforce-only denial returned for a shadow request', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(pooledDenial));
    init({ apiKey: KEY, control: { mode: 'shadow' } });
    await expect(reserveUsage(llmInput())).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
      controlReason: 'invalid_response',
      retryable: false,
      local: true,
    });
  });

  it.each(['shadow_would_allow', 'shadow_would_deny', 'shadow_control_unavailable'] as const)(
    'rejects shadow-only %s responses for enforce requests under allow and deny',
    async (reason) => {
      const body = {
        schema_version: '1.0',
        decision: 'bypassed',
        allowed: true,
        decision_id: reason === 'shadow_control_unavailable' ? null : DECISION_ID,
        operation_id: OPERATION_ID,
        reason,
        would_have_denied:
          reason === 'shadow_control_unavailable' ? null : reason === 'shadow_would_deny',
        warnings: [],
      };
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json(capabilities))
        .mockResolvedValueOnce(json(body));
      init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
      await expect(reserveUsage(llmInput())).resolves.toMatchObject({
        decision: 'unavailable',
        allowed: false,
        controlReason: 'invalid_response',
        retryable: false,
      });

      _resetControlClientForTests();
      fetchSpy.mockResolvedValueOnce(json(capabilities)).mockResolvedValueOnce(json(body));
      init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'deny' } });
      await expect(reserveUsage(llmInput())).rejects.toMatchObject({
        name: 'PylvaControlUnavailableError',
        reason: 'invalid_response',
        retryable: false,
      });
    },
  );

  it.each([reserved, unavailable])(
    'rejects a non-shadow decision returned for a shadow request under deny %#',
    async (body) => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json(capabilities))
        .mockResolvedValueOnce(json(body));
      init({ apiKey: KEY, control: { mode: 'shadow', onUnavailable: 'deny' } });
      await expect(reserveUsage(llmInput())).rejects.toMatchObject({
        name: 'PylvaControlUnavailableError',
        reason: 'invalid_response',
        retryable: false,
      });
    },
  );

  it('rejects mismatched operation identity as invalid response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(
        json({ ...reserved, operation_id: '77777777-7777-4777-8777-777777777777' }),
      );
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
    await expect(reserveUsage(llmInput())).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
      controlReason: 'invalid_response',
      retryable: false,
    });
  });

  it.each([
    [429, 'RATE_LIMIT_EXCEEDED', 'rate_limit_error', 'rate_limited'],
    [503, 'INTERNAL_ERROR', 'api_error', 'service_unavailable'],
  ])(
    'maps valid HTTP %s availability errors without exposing backend text',
    async (status, code, type, reason) => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(json(capabilities))
        .mockResolvedValueOnce(
          json({ error: { type, code, message: 'sensitive infrastructure text' } }, status),
        );
      init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
      const result = await reserveUsage(llmInput());
      expect(result).toMatchObject({
        decision: 'unavailable',
        allowed: false,
        controlReason: reason,
        retryable: true,
      });
      expect(JSON.stringify(result)).not.toContain('sensitive infrastructure text');
    },
  );

  it('never converts deterministic request errors into an unavailable allow result', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(
        json(
          {
            error: {
              type: 'invalid_request_error',
              code: 'VALIDATION_ERROR',
              message: 'backend details',
              param: 'PRIVATE_BACKEND_PARAM_SECRET',
            },
          },
          400,
        ),
      );
    init({ apiKey: KEY, control: { mode: 'enforce', onUnavailable: 'allow' } });
    try {
      await reserveUsage(llmInput());
      expect.fail('reserveUsage should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PylvaControlApiError);
      expect(String(error)).not.toContain('backend details');
      expect(JSON.stringify(error)).not.toContain('PRIVATE_BACKEND_PARAM_SECRET');
      expect(error).toMatchObject({ param: null });
    }
  });

  it('reuses caller identity exactly across explicit idempotent retries', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(reserved))
      .mockResolvedValueOnce(json(reserved));
    init({ apiKey: KEY, control: { mode: 'enforce' } });
    await reserveUsage(llmInput());
    await reserveUsage(llmInput());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(fetchSpy.mock.calls[2]?.[1]?.body);
  });
});
