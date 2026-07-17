import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@pylva/shared';
import {
  BudgetControlServiceError,
  MAX_BUDGET_CONTROL_REQUEST_BYTES,
  createBudgetControlHttpHandler,
  defaultBudgetControlServiceAdapter,
  readBoundedBudgetControlBody,
  type BudgetControlServiceAdapter,
  type BudgetControlServiceContext,
} from '../../src/lib/budget-control/http-handler';

const productionServiceMocks = vi.hoisted(() => ({
  reserveBudgetUsage: vi.fn(),
  commitBudgetUsage: vi.fn(),
  releaseBudgetUsage: vi.fn(),
  extendBudgetUsage: vi.fn(),
}));

vi.mock('../../src/lib/budget-control/reservation-service', () => ({
  reserveBudgetUsage: productionServiceMocks.reserveBudgetUsage,
}));
vi.mock('../../src/lib/budget-control/lifecycle-service', () => ({
  commitBudgetUsage: productionServiceMocks.commitBudgetUsage,
  releaseBudgetUsage: productionServiceMocks.releaseBudgetUsage,
  extendBudgetUsage: productionServiceMocks.extendBudgetUsage,
}));

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';
const TRACE_ID = '44444444-4444-4444-8444-444444444444';
const SPAN_ID = '55555555-5555-4555-8555-555555555555';
const EXTENSION_ID = '66666666-6666-4666-8666-666666666666';

const context: BudgetControlServiceContext = {
  builderId: '77777777-7777-4777-8777-777777777777',
  keyId: 'key-id',
  sdkIdentity: { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
};

const reserveRequest = {
  schema_version: '1.0',
  mode: 'enforce',
  operation_id: OPERATION_ID,
  customer_id: 'customer-1',
  trace_id: TRACE_ID,
  span_id: SPAN_ID,
  parent_span_id: null,
  step_name: null,
  kind: 'llm',
  provider: 'openai',
  model: 'gpt-4o-mini',
  estimated_input_tokens: 10,
  max_output_tokens: 20,
};

const reserveResponse = {
  schema_version: '1.0',
  decision: 'reserved',
  allowed: true,
  decision_id: DECISION_ID,
  operation_id: OPERATION_ID,
  reservation_id: RESERVATION_ID,
  state: 'reserved',
  reserved_usd: '0.01',
  remaining_usd: '0.99',
  expires_at: '2026-07-14T00:05:00.000Z',
  warnings: [],
};

const commitRequest = {
  schema_version: '1.0',
  kind: 'llm',
  actual_input_tokens: 8,
  actual_output_tokens: 12,
  status: 'success',
  latency_ms: 50,
  stream_aborted: false,
};

const commitResponse = {
  schema_version: '1.0',
  state: 'committed',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  reserved_usd: '0.01',
  actual_usd: '0.008',
  released_usd: '0.002',
  overage_usd: '0',
  budget_exceeded_after_commit: false,
  committed_at: '2026-07-14T00:01:00.000Z',
  idempotent_replay: false,
  late: false,
};

const releaseResponse = {
  schema_version: '1.0',
  state: 'released',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  released_usd: '0.01',
  released_at: '2026-07-14T00:01:00.000Z',
  idempotent_replay: false,
};

const extendResponse = {
  schema_version: '1.0',
  state: 'reserved',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  extension_id: EXTENSION_ID,
  expires_at: '2026-07-14T00:10:00.000Z',
  idempotent_replay: false,
};

function services(
  overrides: Partial<BudgetControlServiceAdapter> = {},
): BudgetControlServiceAdapter {
  return {
    reserveBudgetUsage: vi.fn().mockResolvedValue(reserveResponse),
    commitBudgetUsage: vi.fn().mockResolvedValue(commitResponse),
    releaseBudgetUsage: vi.fn().mockResolvedValue(releaseResponse),
    extendBudgetUsage: vi.fn().mockResolvedValue(extendResponse),
    ...overrides,
  };
}

function parsedBody(response: { body: string }): unknown {
  return JSON.parse(response.body) as unknown;
}

function streamRequest(
  chunks: Array<Uint8Array | Error>,
  options: { contentLength?: string; onCancel?: () => void } = {},
): Request {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
      } else if (chunk instanceof Error) {
        controller.error(chunk);
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      options.onCancel?.();
    },
  });
  return new Request('https://api.pylva.test/api/v1/budget/reservations', {
    method: 'POST',
    body: stream,
    ...(options.contentLength ? { headers: { 'Content-Length': options.contentLength } } : {}),
    // Required by Node's Fetch implementation for a streaming request body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('readBoundedBudgetControlBody', () => {
  it('accepts an exact-boundary body', async () => {
    const rawBody = 'x'.repeat(MAX_BUDGET_CONTROL_REQUEST_BYTES);
    const result = await readBoundedBudgetControlBody(
      new Request('https://api.pylva.test', { method: 'POST', body: rawBody }),
    );
    expect(result).toEqual({ success: true, rawBody });
  });

  it('rejects and cancels a chunked body one byte over the boundary', async () => {
    const cancelled = vi.fn();
    const request = streamRequest(
      [
        new Uint8Array(MAX_BUDGET_CONTROL_REQUEST_BYTES),
        new Uint8Array([0x20]),
        new Uint8Array([0x21]),
      ],
      { onCancel: cancelled },
    );
    const result = await readBoundedBudgetControlBody(request);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    expect(result.response.headers?.['Cache-Control']).toBe('no-store');
    expect(parsedBody(result.response)).toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'body' },
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels an advertised oversized body without reading it', async () => {
    const cancelled = vi.fn();
    const request = streamRequest([new Uint8Array([0x7b])], {
      contentLength: String(MAX_BUDGET_CONTROL_REQUEST_BYTES + 1),
      onCancel: cancelled,
    });
    const result = await readBoundedBudgetControlBody(request);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('does not trust a smaller Content-Length header', async () => {
    const request = streamRequest([new Uint8Array(MAX_BUDGET_CONTROL_REQUEST_BYTES + 1)], {
      contentLength: '1',
    });
    const result = await readBoundedBudgetControlBody(request);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
  });

  it('enforces the streaming cap when Content-Length is malformed', async () => {
    const request = streamRequest([new Uint8Array(MAX_BUDGET_CONTROL_REQUEST_BYTES + 1)], {
      contentLength: 'not-a-number',
    });
    const result = await readBoundedBudgetControlBody(request);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
  });

  it('decodes valid UTF-8 split across chunks', async () => {
    const request = streamRequest([
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xe2]),
      new Uint8Array([0x82]),
      new Uint8Array([0xac, 0x22, 0x7d]),
    ]);
    await expect(readBoundedBudgetControlBody(request)).resolves.toEqual({
      success: true,
      rawBody: '{"x":"€"}',
    });
  });

  it('rejects malformed UTF-8 without reflecting input bytes', async () => {
    const result = await readBoundedBudgetControlBody(
      streamRequest([new Uint8Array([0x7b, 0x22, 0xc3, 0x28])]),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    expect(result.response.body).toContain('Request body must be valid UTF-8');
    expect(result.response.body).not.toContain('195');
  });

  it('rejects an incomplete final UTF-8 sequence', async () => {
    const result = await readBoundedBudgetControlBody(
      streamRequest([new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xe2, 0x82])]),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(400);
    expect(result.response.headers?.['Cache-Control']).toBe('no-store');
    expect(parsedBody(result.response)).toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'body' },
    });
  });

  it('turns stream read failures into a sanitized non-cacheable 500', async () => {
    const result = await readBoundedBudgetControlBody(
      streamRequest([new Error('secret stream failure')]),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(500);
    expect(result.response.headers?.['Cache-Control']).toBe('no-store');
    expect(result.response.body).not.toContain('secret');
  });

  it('turns an already-locked stream into a sanitized 500', async () => {
    const request = streamRequest([new Uint8Array([0x7b, 0x7d])]);
    const reader = request.body!.getReader();
    const result = await readBoundedBudgetControlBody(request);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(500);
    expect(result.response.headers?.['Cache-Control']).toBe('no-store');
    await reader.cancel();
  });

  it('returns an empty body when no request body exists', async () => {
    await expect(
      readBoundedBudgetControlBody(new Request('https://api.pylva.test')),
    ).resolves.toEqual({ success: true, rawBody: '' });
  });
});

describe('budget-control HTTP handler', () => {
  it('wires the production adapter to backend service signatures', async () => {
    productionServiceMocks.reserveBudgetUsage.mockResolvedValueOnce(reserveResponse);
    productionServiceMocks.commitBudgetUsage.mockResolvedValueOnce(commitResponse);
    productionServiceMocks.releaseBudgetUsage.mockResolvedValueOnce(releaseResponse);
    productionServiceMocks.extendBudgetUsage.mockResolvedValueOnce(extendResponse);

    await expect(
      defaultBudgetControlServiceAdapter.reserveBudgetUsage(context, reserveRequest as never),
    ).resolves.toEqual(reserveResponse);
    await expect(
      defaultBudgetControlServiceAdapter.commitBudgetUsage(
        context,
        RESERVATION_ID,
        commitRequest as never,
      ),
    ).resolves.toEqual(commitResponse);
    await expect(
      defaultBudgetControlServiceAdapter.releaseBudgetUsage(context, RESERVATION_ID, {
        schema_version: '1.0',
        reason: 'provider_not_called',
      }),
    ).resolves.toEqual(releaseResponse);
    await expect(
      defaultBudgetControlServiceAdapter.extendBudgetUsage(context, RESERVATION_ID, {
        schema_version: '1.0',
        extension_id: EXTENSION_ID,
        extend_by_seconds: 30,
      }),
    ).resolves.toEqual(extendResponse);

    expect(productionServiceMocks.reserveBudgetUsage).toHaveBeenCalledWith(
      context.builderId,
      reserveRequest,
      context.sdkIdentity,
    );
    expect(productionServiceMocks.commitBudgetUsage).toHaveBeenCalledWith(
      context.builderId,
      RESERVATION_ID,
      commitRequest,
      context.sdkIdentity,
    );
    expect(productionServiceMocks.releaseBudgetUsage).toHaveBeenCalledWith(
      context.builderId,
      RESERVATION_ID,
      { schema_version: '1.0', reason: 'provider_not_called' },
      context.sdkIdentity,
    );
    expect(productionServiceMocks.extendBudgetUsage).toHaveBeenCalledWith(
      context.builderId,
      RESERVATION_ID,
      { schema_version: '1.0', extension_id: EXTENSION_ID, extend_by_seconds: 30 },
      context.sdkIdentity,
    );
  });

  it('reports live capability readiness with exact lease bounds and no-store', async () => {
    const controlEnabled = vi.fn().mockResolvedValue(true);
    const handler = createBudgetControlHttpHandler({
      services: services(),
      controlEnabled,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    });
    const response = await handler.capabilities(context);
    expect(response.status).toBe(200);
    expect(response.headers?.['Cache-Control']).toBe('no-store');
    expect(parsedBody(response)).toEqual({
      schema_version: '1.0',
      control_enabled: true,
      min_reservation_ttl_seconds: 30,
      default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600,
      server_time: '2026-07-14T00:00:00.000Z',
    });
    expect(controlEnabled).toHaveBeenCalledWith(context);
  });

  it('defaults capabilities to disabled and sanitizes readiness failures', async () => {
    const disabled = await createBudgetControlHttpHandler({ services: services() }).capabilities(
      context,
    );
    expect(parsedBody(disabled)).toMatchObject({ control_enabled: false });

    const failed = await createBudgetControlHttpHandler({
      services: services(),
      controlEnabled: () => {
        throw new Error('postgres password and table name');
      },
    }).capabilities(context);
    expect(failed.status).toBe(500);
    expect(failed.body).not.toContain('postgres');
    expect(failed.headers?.['Cache-Control']).toBe('no-store');
  });

  it('validates, normalizes, and defaults a reserve request before service invocation', async () => {
    const reserveBudgetUsage = vi.fn().mockResolvedValue(reserveResponse);
    const handler = createBudgetControlHttpHandler({
      services: services({ reserveBudgetUsage }),
    });
    const response = await handler.reserve({
      context,
      rawBody: JSON.stringify({
        ...reserveRequest,
        operation_id: OPERATION_ID.toUpperCase(),
        trace_id: TRACE_ID.toUpperCase(),
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers?.['Cache-Control']).toBe('no-store');
    expect(reserveBudgetUsage).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        operation_id: OPERATION_ID,
        trace_id: TRACE_ID,
        framework: 'none',
        reservation_ttl_seconds: 300,
      }),
    );
  });

  it.each([
    ['', 'body'],
    ['{', 'body'],
    [JSON.stringify({ ...reserveRequest, unexpected_private_payload: 'secret' }), 'body'],
    [JSON.stringify({ ...reserveRequest, max_output_tokens: -1 }), 'max_output_tokens'],
  ])('rejects malformed or schema-invalid reserve JSON without service calls', async (rawBody) => {
    const reserveBudgetUsage = vi.fn().mockResolvedValue(reserveResponse);
    const response = await createBudgetControlHttpHandler({
      services: services({ reserveBudgetUsage }),
    }).reserve({ context, rawBody });
    expect(response.status).toBe(400);
    expect(response.headers?.['Cache-Control']).toBe('no-store');
    expect(parsedBody(response)).toMatchObject({ error: { code: ErrorCode.VALIDATION_ERROR } });
    expect(response.body).not.toContain('secret');
    expect(reserveBudgetUsage).not.toHaveBeenCalled();
  });

  it('rejects an invalid service success payload and never reflects its fields', async () => {
    const response = await createBudgetControlHttpHandler({
      services: services({
        reserveBudgetUsage: vi.fn().mockResolvedValue({ invalid: true, secret: 'private-value' }),
      }),
    }).reserve({ context, rawBody: JSON.stringify(reserveRequest) });
    expect(response.status).toBe(500);
    expect(response.body).not.toContain('private-value');
  });

  it('drops additive service fields before writing a valid response', async () => {
    const response = await createBudgetControlHttpHandler({
      services: services({
        reserveBudgetUsage: vi
          .fn()
          .mockResolvedValue({ ...reserveResponse, internal_cost_source: 'must-not-leak' }),
      }),
    }).reserve({ context, rawBody: JSON.stringify(reserveRequest) });
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('must-not-leak');
    expect(parsedBody(response)).toEqual(reserveResponse);
  });

  it.each([
    [ErrorCode.RESOURCE_NOT_FOUND, 404],
    [ErrorCode.IDEMPOTENCY_CONFLICT, 409],
    [ErrorCode.RESERVATION_STATE_CONFLICT, 409],
  ] as const)(
    'maps lifecycle service code %s to %i without reflecting messages',
    async (code, status) => {
      const error = new BudgetControlServiceError(code);
      error.message = 'tenant secret and raw database text';
      const response = await createBudgetControlHttpHandler({
        services: services({ commitBudgetUsage: vi.fn().mockRejectedValue(error) }),
      }).commit({
        context,
        reservationId: RESERVATION_ID,
        rawBody: JSON.stringify(commitRequest),
      });
      expect(response.status).toBe(status);
      expect(response.body).toContain(code);
      expect(response.body).not.toContain('tenant secret');
      expect(response.headers?.['Cache-Control']).toBe('no-store');
    },
  );

  it('maps reserve idempotency conflicts but rejects impossible reserve status codes', async () => {
    const conflict = await createBudgetControlHttpHandler({
      services: services({
        reserveBudgetUsage: vi
          .fn()
          .mockRejectedValue(new BudgetControlServiceError(ErrorCode.IDEMPOTENCY_CONFLICT)),
      }),
    }).reserve({ context, rawBody: JSON.stringify(reserveRequest) });
    expect(conflict.status).toBe(409);
    expect(parsedBody(conflict)).toMatchObject({
      error: { code: ErrorCode.IDEMPOTENCY_CONFLICT },
    });

    const impossible = await createBudgetControlHttpHandler({
      services: services({
        reserveBudgetUsage: vi
          .fn()
          .mockRejectedValue(new BudgetControlServiceError(ErrorCode.RESOURCE_NOT_FOUND)),
      }),
    }).reserve({ context, rawBody: JSON.stringify(reserveRequest) });
    expect(impossible.status).toBe(500);
    expect(parsedBody(impossible)).toMatchObject({
      error: { code: ErrorCode.INTERNAL_ERROR },
    });
  });

  it('maps only the typed 503/INTERNAL_ERROR shape to sanitized service unavailable', async () => {
    const schemaBlocker = Object.assign(new Error('actual cost is 123456789 and DB column foo'), {
      status: 503,
      code: ErrorCode.INTERNAL_ERROR,
      actualUsd: '123456789',
    });
    const response = await createBudgetControlHttpHandler({
      services: services({ commitBudgetUsage: vi.fn().mockRejectedValue(schemaBlocker) }),
    }).commit({
      context,
      reservationId: RESERVATION_ID,
      rawBody: JSON.stringify(commitRequest),
    });
    expect(response.status).toBe(503);
    expect(parsedBody(response)).toEqual({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Budget control is temporarily unavailable',
      },
    });
    expect(response.body).not.toContain('123456789');
    expect(response.body).not.toContain('foo');
    expect(response.headers?.['Cache-Control']).toBe('no-store');

    const impostor = await createBudgetControlHttpHandler({
      services: services({
        commitBudgetUsage: vi
          .fn()
          .mockRejectedValue({ status: 503, code: 'OTHER', message: 'secret' }),
      }),
    }).commit({
      context,
      reservationId: RESERVATION_ID,
      rawBody: JSON.stringify(commitRequest),
    });
    expect(impostor.status).toBe(500);
    expect(impostor.body).not.toContain('secret');
  });

  it('normalizes lifecycle IDs and validates commit request/response arithmetic', async () => {
    const commitBudgetUsage = vi.fn().mockResolvedValue(commitResponse);
    const response = await createBudgetControlHttpHandler({
      services: services({ commitBudgetUsage }),
    }).commit({
      context,
      reservationId: RESERVATION_ID.toUpperCase(),
      rawBody: JSON.stringify(commitRequest),
    });
    expect(response.status).toBe(200);
    expect(parsedBody(response)).toEqual(commitResponse);
    expect(commitBudgetUsage).toHaveBeenCalledWith(context, RESERVATION_ID, commitRequest);
  });

  it('rejects an invalid reservation ID before parsing or service invocation', async () => {
    const commitBudgetUsage = vi.fn().mockResolvedValue(commitResponse);
    const response = await createBudgetControlHttpHandler({
      services: services({ commitBudgetUsage }),
    }).commit({ context, reservationId: 'not-a-uuid', rawBody: '{' });
    expect(response.status).toBe(400);
    expect(parsedBody(response)).toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'reservation_id' },
    });
    expect(commitBudgetUsage).not.toHaveBeenCalled();
  });

  it('routes release and extend through their strict schemas', async () => {
    const releaseBudgetUsage = vi.fn().mockResolvedValue(releaseResponse);
    const extendBudgetUsage = vi.fn().mockResolvedValue(extendResponse);
    const handler = createBudgetControlHttpHandler({
      services: services({ releaseBudgetUsage, extendBudgetUsage }),
    });

    const release = await handler.release({
      context,
      reservationId: RESERVATION_ID,
      rawBody: JSON.stringify({
        schema_version: '1.0',
        reason: 'provider_not_called',
      }),
    });
    expect(release.status).toBe(200);
    expect(parsedBody(release)).toEqual(releaseResponse);
    expect(releaseBudgetUsage).toHaveBeenCalledWith(context, RESERVATION_ID, {
      schema_version: '1.0',
      reason: 'provider_not_called',
    });

    const extend = await handler.extend({
      context,
      reservationId: RESERVATION_ID,
      rawBody: JSON.stringify({
        schema_version: '1.0',
        extension_id: EXTENSION_ID.toUpperCase(),
        extend_by_seconds: 30,
      }),
    });
    expect(extend.status).toBe(200);
    expect(parsedBody(extend)).toEqual(extendResponse);
    expect(extendBudgetUsage).toHaveBeenCalledWith(context, RESERVATION_ID, {
      schema_version: '1.0',
      extension_id: EXTENSION_ID,
      extend_by_seconds: 30,
    });
  });

  it('rejects unknown lifecycle fields and contradictory service arithmetic', async () => {
    const commitBudgetUsage = vi.fn().mockResolvedValue({
      ...commitResponse,
      actual_usd: '0.02',
      released_usd: '0',
      overage_usd: '0',
    });
    const handler = createBudgetControlHttpHandler({
      services: services({ commitBudgetUsage }),
    });
    const unknownField = await handler.commit({
      context,
      reservationId: RESERVATION_ID,
      rawBody: JSON.stringify({ ...commitRequest, prompt: 'must not cross boundary' }),
    });
    expect(unknownField.status).toBe(400);
    expect(commitBudgetUsage).not.toHaveBeenCalled();

    const contradictory = await handler.commit({
      context,
      reservationId: RESERVATION_ID,
      rawBody: JSON.stringify(commitRequest),
    });
    expect(contradictory.status).toBe(500);
    expect(contradictory.body).not.toContain('0.02');
  });
});
