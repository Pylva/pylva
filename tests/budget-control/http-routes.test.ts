import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@pylva/shared';
import { NextRequest } from 'next/server.js';
import * as reserveRoute from '../../src/app/api/v1/budget/reservations/route';
import * as commitRoute from '../../src/app/api/v1/budget/reservations/[id]/commit/route';
import * as releaseRoute from '../../src/app/api/v1/budget/reservations/[id]/release/route';
import * as extendRoute from '../../src/app/api/v1/budget/reservations/[id]/extend/route';
import { MAX_BUDGET_CONTROL_REQUEST_BYTES } from '../../src/lib/budget-control/http-handler';
import {
  createCommitBudgetControlPOST,
  createExtendBudgetControlPOST,
  createReleaseBudgetControlPOST,
  createReserveBudgetControlPOST,
} from '../../src/lib/budget-control/http-next-route';

const productionServiceMocks = vi.hoisted(() => ({
  reservationModuleLoaded: vi.fn(),
  lifecycleModuleLoaded: vi.fn(),
  reserveBudgetUsage: vi.fn(),
  commitBudgetUsage: vi.fn(),
  releaseBudgetUsage: vi.fn(),
  extendBudgetUsage: vi.fn(),
}));

vi.mock('../../src/lib/budget-control/reservation-service', () => {
  productionServiceMocks.reservationModuleLoaded();
  return { reserveBudgetUsage: productionServiceMocks.reserveBudgetUsage };
});
vi.mock('../../src/lib/budget-control/lifecycle-service', () => {
  productionServiceMocks.lifecycleModuleLoaded();
  return {
    commitBudgetUsage: productionServiceMocks.commitBudgetUsage,
    releaseBudgetUsage: productionServiceMocks.releaseBudgetUsage,
    extendBudgetUsage: productionServiceMocks.extendBudgetUsage,
  };
});

const BUILDER_ID = '77777777-7777-4777-8777-777777777777';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const DECISION_ID = '33333333-3333-4333-8333-333333333333';
const TRACE_ID = '44444444-4444-4444-8444-444444444444';
const SPAN_ID = '55555555-5555-4555-8555-555555555555';
const EXTENSION_ID = '66666666-6666-4666-8666-666666666666';

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

const releaseRequest = { schema_version: '1.0', reason: 'provider_not_called' };
const releaseResponse = {
  schema_version: '1.0',
  state: 'released',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  released_usd: '0.01',
  released_at: '2026-07-14T00:01:00.000Z',
  idempotent_replay: false,
};

const extendRequest = {
  schema_version: '1.0',
  extension_id: EXTENSION_ID,
  extend_by_seconds: 30,
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

function requestHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'Content-Type': 'application/json',
    'X-Builder-Id': BUILDER_ID,
    'X-Key-Id': 'key-id',
    'X-Pylva-SDK-Language': 'typescript',
    'X-Pylva-SDK-Version': '1.2.0',
    ...overrides,
  });
}

function request(
  path: string,
  body: BodyInit,
  options: { headers?: Headers; contentLength?: string } = {},
): NextRequest {
  const headers = options.headers ?? requestHeaders();
  if (options.contentLength !== undefined) headers.set('Content-Length', options.contentLength);
  const init = {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  };
  return new NextRequest(
    `https://api.pylva.test${path}`,
    init as unknown as NonNullable<ConstructorParameters<typeof NextRequest>[1]>,
  );
}

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

async function errorBody(response: Response): Promise<{
  error: { code: string; message: string; param?: string };
}> {
  return (await response.json()) as {
    error: { code: string; message: string; param?: string };
  };
}

function expectJsonNoStore(response: Response, status: number): void {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toContain('application/json');
}

describe('authoritative budget-control Next routes', () => {
  it('exports only the Next-supported POST method from every mutation route', () => {
    for (const module of [reserveRoute, commitRoute, releaseRoute, extendRoute]) {
      expect(Object.keys(module)).toEqual(['POST']);
      expect(module.POST).toBeTypeOf('function');
    }
    expect(productionServiceMocks.reservationModuleLoaded).not.toHaveBeenCalled();
    expect(productionServiceMocks.lifecycleModuleLoaded).not.toHaveBeenCalled();
  });

  it('runs a reserve request through the live route with trusted and allowlisted context', async () => {
    productionServiceMocks.reserveBudgetUsage.mockResolvedValueOnce(reserveResponse);
    const response = await reserveRoute.POST(
      request(
        '/api/v1/budget/reservations',
        JSON.stringify({
          ...reserveRequest,
          operation_id: OPERATION_ID.toUpperCase(),
        }),
      ),
    );

    expectJsonNoStore(response, 200);
    expect(await response.json()).toEqual(reserveResponse);
    expect(productionServiceMocks.reserveBudgetUsage).toHaveBeenCalledWith(
      BUILDER_ID,
      expect.objectContaining({
        operation_id: OPERATION_ID,
        framework: 'none',
        reservation_ttl_seconds: 300,
      }),
      { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
    );
  });

  it('sanitizes missing middleware context identically across all four mutation routes', async () => {
    const reserveService = vi.fn(async () => reserveResponse);
    const commitService = vi.fn(async () => commitResponse);
    const releaseService = vi.fn(async () => releaseResponse);
    const extendService = vi.fn(async () => extendResponse);
    const missingContext = () => requestHeaders({ 'X-Builder-Id': '', 'X-Key-Id': '' });

    const responses = [
      await createReserveBudgetControlPOST(reserveService)(
        request('/api/v1/budget/reservations', JSON.stringify(reserveRequest), {
          headers: missingContext(),
        }),
      ),
      await createCommitBudgetControlPOST(commitService)(
        request(
          `/api/v1/budget/reservations/${RESERVATION_ID}/commit`,
          JSON.stringify(commitRequest),
          { headers: missingContext() },
        ),
        { params: Promise.resolve({ id: RESERVATION_ID }) },
      ),
      await createReleaseBudgetControlPOST(releaseService)(
        request(
          `/api/v1/budget/reservations/${RESERVATION_ID}/release`,
          JSON.stringify(releaseRequest),
          { headers: missingContext() },
        ),
        { params: Promise.resolve({ id: RESERVATION_ID }) },
      ),
      await createExtendBudgetControlPOST(extendService)(
        request(
          `/api/v1/budget/reservations/${RESERVATION_ID}/extend`,
          JSON.stringify(extendRequest),
          { headers: missingContext() },
        ),
        { params: Promise.resolve({ id: RESERVATION_ID }) },
      ),
    ];

    for (const response of responses) {
      expectJsonNoStore(response, 500);
      const body = await errorBody(response);
      expect(body.error).toEqual({
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An internal error occurred',
      });
      expect(JSON.stringify(body)).not.toMatch(/x-builder-id|x-key-id|middleware/u);
    }
    for (const service of [reserveService, commitService, releaseService, extendService]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it('enforces the streaming cap despite a dishonest smaller Content-Length', async () => {
    const service = vi.fn(async () => reserveResponse);
    const body = stream([new Uint8Array(MAX_BUDGET_CONTROL_REQUEST_BYTES), new Uint8Array([0x20])]);
    const response = await createReserveBudgetControlPOST(service)(
      request('/api/v1/budget/reservations', body, { contentLength: '1' }),
    );

    expectJsonNoStore(response, 400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'body' },
    });
    expect(service).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8 at the live route without reflecting bytes', async () => {
    const service = vi.fn(async () => reserveResponse);
    const response = await createReserveBudgetControlPOST(service)(
      request('/api/v1/budget/reservations', stream([new Uint8Array([0x7b, 0x22, 0xc3, 0x28])])),
    );

    expectJsonNoStore(response, 400);
    const body = await errorBody(response);
    expect(body.error).toMatchObject({ code: ErrorCode.VALIDATION_ERROR, param: 'body' });
    expect(JSON.stringify(body)).not.toContain('195');
    expect(service).not.toHaveBeenCalled();
  });

  it('maps a typed readiness failure to a sanitized live 503', async () => {
    const service = vi.fn(async () => {
      throw Object.assign(new Error('database password and actual cost 9000'), {
        status: 503,
        code: ErrorCode.INTERNAL_ERROR,
        actualUsd: '9000',
      });
    });
    const response = await createReserveBudgetControlPOST(service)(
      request('/api/v1/budget/reservations', JSON.stringify(reserveRequest)),
    );

    expectJsonNoStore(response, 503);
    const body = await errorBody(response);
    expect(body.error).toEqual({
      type: 'api_error',
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Budget control is temporarily unavailable',
    });
    expect(JSON.stringify(body)).not.toMatch(/password|9000/);
  });

  it('maps dedicated database posture refusal to a sanitized 503 on every mutation route', async () => {
    const rejectPosture = () =>
      Promise.reject(
        Object.assign(new Error('dangerous_role_membership must not escape'), {
          status: 503,
          code: ErrorCode.INTERNAL_ERROR,
        }),
      );
    productionServiceMocks.reserveBudgetUsage.mockImplementationOnce(rejectPosture);
    productionServiceMocks.commitBudgetUsage.mockImplementationOnce(rejectPosture);
    productionServiceMocks.releaseBudgetUsage.mockImplementationOnce(rejectPosture);
    productionServiceMocks.extendBudgetUsage.mockImplementationOnce(rejectPosture);

    const responses = [
      await reserveRoute.POST(
        request('/api/v1/budget/reservations', JSON.stringify(reserveRequest)),
      ),
      await commitRoute.POST(
        request(
          `/api/v1/budget/reservations/${RESERVATION_ID}/commit`,
          JSON.stringify(commitRequest),
        ),
        { params: Promise.resolve({ id: RESERVATION_ID }) },
      ),
      await releaseRoute.POST(
        request(
          `/api/v1/budget/reservations/${RESERVATION_ID}/release`,
          JSON.stringify(releaseRequest),
        ),
        { params: Promise.resolve({ id: RESERVATION_ID }) },
      ),
      await extendRoute.POST(
        request(
          `/api/v1/budget/reservations/${RESERVATION_ID}/extend`,
          JSON.stringify(extendRequest),
        ),
        { params: Promise.resolve({ id: RESERVATION_ID }) },
      ),
    ];

    for (const response of responses) {
      expectJsonNoStore(response, 503);
      expect(await errorBody(response)).toEqual({
        error: {
          type: 'api_error',
          code: ErrorCode.INTERNAL_ERROR,
          message: 'Budget control is temporarily unavailable',
        },
      });
    }
  });

  it('normalizes the commit path UUID and passes SDK identity to the lifecycle service', async () => {
    productionServiceMocks.commitBudgetUsage.mockResolvedValueOnce(commitResponse);
    const response = await commitRoute.POST(
      request(
        `/api/v1/budget/reservations/${RESERVATION_ID}/commit`,
        JSON.stringify(commitRequest),
      ),
      { params: Promise.resolve({ id: RESERVATION_ID.toUpperCase() }) },
    );

    expectJsonNoStore(response, 200);
    expect(await response.json()).toEqual(commitResponse);
    expect(productionServiceMocks.commitBudgetUsage).toHaveBeenCalledWith(
      BUILDER_ID,
      RESERVATION_ID,
      commitRequest,
      { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
    );
  });

  it('runs release and extend through their concrete Next route modules', async () => {
    productionServiceMocks.releaseBudgetUsage.mockResolvedValueOnce(releaseResponse);
    const release = await releaseRoute.POST(
      request(
        `/api/v1/budget/reservations/${RESERVATION_ID}/release`,
        JSON.stringify(releaseRequest),
      ),
      { params: Promise.resolve({ id: RESERVATION_ID }) },
    );
    expectJsonNoStore(release, 200);
    expect(await release.json()).toEqual(releaseResponse);
    expect(productionServiceMocks.releaseBudgetUsage).toHaveBeenCalledWith(
      BUILDER_ID,
      RESERVATION_ID,
      releaseRequest,
      { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
    );

    productionServiceMocks.extendBudgetUsage.mockResolvedValueOnce(extendResponse);
    const extend = await extendRoute.POST(
      request(
        `/api/v1/budget/reservations/${RESERVATION_ID}/extend`,
        JSON.stringify({ ...extendRequest, extension_id: EXTENSION_ID.toUpperCase() }),
      ),
      { params: Promise.resolve({ id: RESERVATION_ID }) },
    );
    expectJsonNoStore(extend, 200);
    expect(await extend.json()).toEqual(extendResponse);
    expect(productionServiceMocks.extendBudgetUsage).toHaveBeenCalledWith(
      BUILDER_ID,
      RESERVATION_ID,
      extendRequest,
      { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
    );
  });

  it('rejects an invalid path UUID before lifecycle invocation', async () => {
    const service = vi.fn(async () => releaseResponse);
    const response = await createReleaseBudgetControlPOST(service)(
      request('/api/v1/budget/reservations/not-a-uuid/release', JSON.stringify(releaseRequest)),
      { params: Promise.resolve({ id: 'not-a-uuid' }) },
    );

    expectJsonNoStore(response, 400);
    expect(await errorBody(response)).toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR, param: 'reservation_id' },
    });
    expect(service).not.toHaveBeenCalled();
  });

  it('sanitizes a rejected Next route-parameter promise', async () => {
    const service = vi.fn(async () => extendResponse);
    const response = await createExtendBudgetControlPOST(service)(
      request(
        `/api/v1/budget/reservations/${RESERVATION_ID}/extend`,
        JSON.stringify(extendRequest),
      ),
      { params: Promise.reject(new Error('private router failure')) },
    );

    expectJsonNoStore(response, 500);
    const body = await errorBody(response);
    expect(body.error).toMatchObject({ code: ErrorCode.INTERNAL_ERROR });
    expect(JSON.stringify(body)).not.toContain('private router failure');
    expect(service).not.toHaveBeenCalled();
  });
});
