// Contract tests for POST /api/v1/simulator/run.
//
// Mocking style mirrors tests/rules/rule-id-route-contract.test.ts: only the
// I/O seams are mocked (config env, the feature gate, and the engine). The
// builder-context reader, the valibot validator, and the CSV exporter run
// for real.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';
import { ErrorCode, type SimulatorResult } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  checkDashboardFeatureGate: vi.fn(),
  runSimulation: vi.fn(),
  env: { ENABLE_SIMULATOR: true },
}));

vi.mock('@/lib/config', () => ({
  env: mocks.env,
}));

vi.mock('@/lib/auth/dashboard-feature-gate', () => ({
  checkDashboardFeatureGate: mocks.checkDashboardFeatureGate,
}));

vi.mock('@/lib/simulator/engine', () => ({
  runSimulation: mocks.runSimulation,
}));

const route = await import('../../src/app/api/v1/simulator/run/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';

const engineResult: SimulatorResult = {
  original_cost_usd: 100,
  simulated_cost_usd: 40,
  savings_usd: 60,
  savings_percent: 60,
  breakdown: [
    {
      customer_id: 'cust-1',
      provider: 'openai',
      step_name: 'chat',
      original_model: 'gpt-4o',
      simulated_model: 'gpt-4o-mini',
      original_cost_usd: 100,
      simulated_cost_usd: 40,
      event_count: 5,
    },
  ],
  period_start: '2026-01-01T00:00:00.000Z',
  period_end: '2026-01-31T00:00:00.000Z',
  freshness_timestamp: '2026-01-30',
  warnings: [],
};

const swap = {
  from_model: 'gpt-4o',
  to_model: 'gpt-4o-mini',
  from_provider: 'openai',
  to_provider: 'openai',
};

const validBody = {
  period_start: '2026-01-01',
  period_end: '2026-01-31',
  model_swaps: [swap],
};

function request(
  body: unknown,
  opts: { builderId?: string | null; format?: string } = {},
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.builderId !== null) headers['x-builder-id'] = opts.builderId ?? BUILDER_ID;
  const url =
    'http://localhost/api/v1/simulator/run' + (opts.format ? `?format=${opts.format}` : '');
  return new NextRequest(url, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.ENABLE_SIMULATOR = true;
  mocks.checkDashboardFeatureGate.mockResolvedValue(null);
  mocks.runSimulation.mockResolvedValue(engineResult);
});

describe('POST /api/v1/simulator/run — gates', () => {
  it('returns 503 before auth or parsing when the simulator flag is off', async () => {
    mocks.env.ENABLE_SIMULATOR = false;

    const response = await route.POST(request(validBody));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'FEATURE_DISABLED', message: 'Cost simulator is currently disabled' },
    });
    expect(mocks.checkDashboardFeatureGate).not.toHaveBeenCalled();
    expect(mocks.runSimulation).not.toHaveBeenCalled();
  });

  it('passes through the auth error when middleware did not inject x-builder-id', async () => {
    const response = await route.POST(request(validBody, { builderId: null }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.INTERNAL_ERROR },
    });
    expect(mocks.checkDashboardFeatureGate).not.toHaveBeenCalled();
    expect(mocks.runSimulation).not.toHaveBeenCalled();
  });

  it('passes through the feature-gate response verbatim', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValueOnce(
      NextResponse.json(
        { error: { code: ErrorCode.FEATURE_NOT_AVAILABLE, message: 'Upgrade required' } },
        { status: 403 },
      ),
    );

    const response = await route.POST(request(validBody));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: ErrorCode.FEATURE_NOT_AVAILABLE, message: 'Upgrade required' },
    });
    expect(mocks.checkDashboardFeatureGate).toHaveBeenCalledWith(BUILDER_ID, 'simulator');
    expect(mocks.runSimulation).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/simulator/run — body validation', () => {
  it('returns 400 for a non-JSON body', async () => {
    const response = await route.POST(request('not json{'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'invalid_request_error',
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid JSON body',
        param: 'body',
      },
    });
    expect(mocks.runSimulation).not.toHaveBeenCalled();
  });

  it('returns 400 with the validator message and param for an empty swap list', async () => {
    const response = await route.POST(request({ ...validBody, model_swaps: [] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'At least one model swap is required',
        param: 'model_swaps',
      },
    });
    expect(mocks.runSimulation).not.toHaveBeenCalled();
  });

  it('builds a dotted param from the issue path, dropping array indices', async () => {
    const response = await route.POST(
      request({ ...validBody, model_swaps: [{ ...swap, from_model: '' }] }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid length: Expected >=1 but received 0',
        // Numeric path segments (the swap index) are filtered out by the route.
        param: 'model_swaps.from_model',
      },
    });
  });

  it('falls back to param "body" for the pathless date-range check', async () => {
    const response = await route.POST(
      request({ ...validBody, period_start: '2026-02-02', period_end: '2026-02-01' }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Date range must be between 0 and 180 days',
        param: 'body',
      },
    });
    expect(mocks.runSimulation).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/simulator/run — happy paths', () => {
  it('runs the simulation with the parsed input and returns the engine result as JSON', async () => {
    const response = await route.POST(request({ ...validBody, customer_id: 'cust-7' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(engineResult);
    expect(mocks.runSimulation).toHaveBeenCalledTimes(1);
    // builderId is passed as both the query id and the JWT id.
    expect(mocks.runSimulation).toHaveBeenCalledWith(BUILDER_ID, BUILDER_ID, {
      customer_id: 'cust-7',
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-31T00:00:00.000Z',
      model_swaps: [swap],
    });
  });

  it('defaults customer_id to null when omitted', async () => {
    await route.POST(request(validBody));

    expect(mocks.runSimulation).toHaveBeenCalledWith(
      BUILDER_ID,
      BUILDER_ID,
      expect.objectContaining({ customer_id: null }),
    );
  });

  it('returns a CSV attachment when format=csv', async () => {
    const response = await route.POST(request(validBody, { format: 'csv' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="simulation-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const csv = await response.text();
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'customer_id,provider,step_name,original_model,simulated_model,' +
        'original_cost_usd,simulated_cost_usd,savings_usd,event_count',
    );
    expect(lines[1]).toBe('cust-1,openai,chat,gpt-4o,gpt-4o-mini,100.000000,40.000000,60.000000,5');
    expect(lines[2]).toBe('TOTAL,,,,,100.000000,40.000000,60.000000,');
  });
});

describe('POST /api/v1/simulator/run — engine failure', () => {
  it('propagates engine errors (route has no catch — framework converts to a 500)', async () => {
    mocks.runSimulation.mockRejectedValueOnce(new Error('clickhouse exploded'));

    await expect(route.POST(request(validBody))).rejects.toThrow('clickhouse exploded');
  });
});
