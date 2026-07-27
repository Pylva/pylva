import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';

const mocks = vi.hoisted(() => ({
  checkDashboardFeatureGate: vi.fn(),
  readBuilderContextFromDashboard: vi.fn(),
  select: vi.fn(),
  env: { ENABLE_SIMULATOR: true },
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: mocks.readBuilderContextFromDashboard,
}));

vi.mock('@/lib/auth/dashboard-feature-gate', () => ({
  checkDashboardFeatureGate: mocks.checkDashboardFeatureGate,
}));

vi.mock('@/lib/config', () => ({ env: mocks.env }));

vi.mock('@/lib/db/client', () => ({
  db: { select: mocks.select },
}));

const { GET } = await import('../../src/app/api/v1/simulator/models/route.js');

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/v1/simulator/models');
}

describe('GET /api/v1/simulator/models entitlement gate', () => {
  beforeEach(() => {
    mocks.env.ENABLE_SIMULATOR = true;
    mocks.checkDashboardFeatureGate.mockReset();
    mocks.readBuilderContextFromDashboard.mockReset();
    mocks.select.mockReset();
    mocks.readBuilderContextFromDashboard.mockReturnValue({
      builderId: BUILDER_ID,
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'owner',
    });
  });

  it('returns the authoritative denial before reading pricing data', async () => {
    const denial = NextResponse.json(
      { error: { code: 'FEATURE_NOT_AVAILABLE', message: 'denied' } },
      { status: 403 },
    );
    mocks.checkDashboardFeatureGate.mockResolvedValue(denial);

    const response = await GET(request());

    expect(response).toBe(denial);
    expect(mocks.checkDashboardFeatureGate).toHaveBeenCalledWith(BUILDER_ID, 'simulator');
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('fails closed when entitlement resolution fails', async () => {
    const denial = NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'unavailable' } },
      { status: 500 },
    );
    mocks.checkDashboardFeatureGate.mockResolvedValue(denial);

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('returns de-duplicated models only after the feature gate allows access', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValue(null);
    const from = vi.fn().mockResolvedValue([
      {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m: '5.00',
        output_per_1m: '15.00',
      },
      {
        provider: 'openai',
        model: 'gpt-4o',
        input_per_1m: '5.00',
        output_per_1m: '15.00',
      },
    ]);
    mocks.select.mockReturnValue({ from });

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      models: {
        openai: [
          {
            provider: 'openai',
            model: 'gpt-4o',
            input_per_1m: 5,
            output_per_1m: 15,
          },
        ],
      },
    });
  });
});
