import { beforeEach, describe, expect, it, vi } from 'vitest';

const readinessMocks = vi.hoisted(() => ({
  getBudgetControlReadiness: vi.fn(),
}));
const postureMocks = vi.hoisted(() => ({ getBudgetControlProductionPosture: vi.fn() }));
const exactAdapterMocks = vi.hoisted(() => ({ configured: vi.fn() }));

vi.mock('../../src/lib/config.js', () => ({
  env: { ENABLE_AUTHORITATIVE_BUDGET_CONTROL: false },
}));

vi.mock('../../src/lib/budget-control/readiness.js', () => ({
  getBudgetControlReadiness: readinessMocks.getBudgetControlReadiness,
}));
vi.mock('../../src/lib/budget-control/runtime-posture.js', () => ({
  getBudgetControlProductionPosture: postureMocks.getBudgetControlProductionPosture,
}));
vi.mock('../../src/lib/budget-control/exact-backfill-adapter.js', () => ({
  isBudgetExactBackfillAdapterConfigured: exactAdapterMocks.configured,
}));

const { createGET } = await import('../../src/app/api/v1/budget/capabilities/route.js');

const BUILDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUTOVER_AT = '2026-08-01T00:00:00.000Z';

function request(headers: Record<string, string> = {}): import('next/server.js').NextRequest {
  return new Request('http://localhost/api/v1/budget/capabilities', {
    headers: {
      'x-builder-id': BUILDER_ID,
      'x-key-id': 'sdk-key-1',
      'x-pylva-sdk-language': 'typescript',
      'x-pylva-sdk-version': '1.2.0',
      ...headers,
    },
  }) as import('next/server.js').NextRequest;
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('GET /api/v1/budget/capabilities readiness authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exactAdapterMocks.configured.mockReturnValue(false);
    postureMocks.getBudgetControlProductionPosture.mockResolvedValue({
      ready: true,
      reason: null,
      attested: true,
      credential_source: 'dedicated',
    });
  });

  it('short-circuits PostgreSQL readiness while the global kill switch is disabled', async () => {
    const isBuilderReady = vi.fn().mockRejectedValue(new Error('must not be called'));
    const response = await createGET({
      featureEnabled: () => false,
      isBuilderReady,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })(request());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await body(response)).toMatchObject({ control_enabled: false });
    expect(isBuilderReady).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [true, true],
  ])('requires both the feature flag and typed builder readiness %#', async (ready, enabled) => {
    const isBuilderReady = vi.fn().mockResolvedValue(ready);
    const response = await createGET({
      featureEnabled: () => true,
      isBuilderReady,
      now: () => new Date('2026-07-14T00:00:00.000Z'),
    })(request());

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      schema_version: '1.0',
      control_enabled: enabled,
      min_reservation_ttl_seconds: 30,
      default_reservation_ttl_seconds: 300,
      max_reservation_ttl_seconds: 3600,
      server_time: '2026-07-14T00:00:00.000Z',
    });
    expect(isBuilderReady).toHaveBeenCalledWith(
      expect.objectContaining({
        builderId: BUILDER_ID,
        keyId: 'sdk-key-1',
        sdkIdentity: { sdkLanguage: 'typescript', sdkVersion: '1.2.0' },
      }),
    );
  });

  it('enables a ready next-period builder through the production readiness adapter', async () => {
    readinessMocks.getBudgetControlReadiness.mockResolvedValue({
      ready: true,
      mode: 'next_period',
      cutover_at: CUTOVER_AT,
      ready_order: '101',
      ready_at: CUTOVER_AT,
    });

    const response = await createGET({ featureEnabled: () => true })(request());
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ control_enabled: true });
    expect(readinessMocks.getBudgetControlReadiness).toHaveBeenCalledWith(BUILDER_ID);
  });

  it('advertises control disabled when the dedicated database posture is not ready', async () => {
    postureMocks.getBudgetControlProductionPosture.mockResolvedValue({
      ready: false,
      reason: 'credential_missing',
      attested: false,
      credential_source: null,
    });
    readinessMocks.getBudgetControlReadiness.mockRejectedValue(
      new Error('builder readiness must not be queried'),
    );

    const response = await createGET({ featureEnabled: () => true })(request());
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ control_enabled: false });
    expect(readinessMocks.getBudgetControlReadiness).not.toHaveBeenCalled();
  });

  it.each([
    {
      ready: false,
      reason: 'missing',
      mode: null,
      cutover_at: null,
    },
    {
      ready: false,
      reason: 'pending',
      mode: 'next_period',
      cutover_at: CUTOVER_AT,
    },
    {
      ready: true,
      mode: 'exact_backfill',
      cutover_at: CUTOVER_AT,
      ready_order: '101',
      ready_at: CUTOVER_AT,
    },
  ])('fails closed for non-activatable production readiness %#', async (readiness) => {
    readinessMocks.getBudgetControlReadiness.mockResolvedValue(readiness);
    const response = await createGET({ featureEnabled: () => true })(request());
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ control_enabled: false });
  });

  it('advertises ready exact backfill only while the shared production adapter is configured', async () => {
    readinessMocks.getBudgetControlReadiness.mockResolvedValue({
      ready: true,
      mode: 'exact_backfill',
      cutover_at: CUTOVER_AT,
      ready_order: '101',
      ready_at: CUTOVER_AT,
    });
    exactAdapterMocks.configured.mockReturnValue(true);

    const response = await createGET({ featureEnabled: () => true })(request());
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ control_enabled: true });
    expect(exactAdapterMocks.configured).toHaveBeenCalledTimes(1);
  });

  it('sanitizes readiness failures instead of advertising control', async () => {
    readinessMocks.getBudgetControlReadiness.mockRejectedValue(
      new Error('postgres://operator:secret@internal/budget_control_cutovers'),
    );
    const response = await createGET({ featureEnabled: () => true })(request());
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(raw).not.toContain('operator');
    expect(raw).not.toContain('budget_control_cutovers');
  });

  it('rejects a request that bypassed middleware and keeps the error uncacheable', async () => {
    const response = await createGET({ featureEnabled: () => true })(
      request({ 'x-builder-id': '', 'x-key-id': '' }),
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const raw = JSON.stringify(await body(response));
    expect(raw).toContain('Request context is unavailable');
    expect(raw).not.toContain('x-builder-id');
    expect(raw).not.toContain('x-key-id');
    expect(raw).not.toContain('middleware');
    expect(readinessMocks.getBudgetControlReadiness).not.toHaveBeenCalled();
  });
});
