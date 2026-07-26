import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';

const mocks = vi.hoisted(() => ({
  checkDashboardFeatureGate: vi.fn(),
  listAnomalies: vi.fn(),
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: 'builder-1',
    userId: 'user-1',
    role: 'owner',
  }),
}));

vi.mock('../../src/lib/auth/dashboard-feature-gate.js', () => ({
  checkDashboardFeatureGate: mocks.checkDashboardFeatureGate,
}));

vi.mock('../../src/lib/anomaly/repository.js', () => ({
  listAnomalies: mocks.listAnomalies,
}));

vi.mock('../../src/lib/config.js', () => ({
  env: { ENABLE_ADVANCED_RULES: true },
}));

const { GET } = await import('../../src/app/api/v1/anomalies/route.js');

function request(): NextRequest {
  return new NextRequest('http://localhost/api/v1/anomalies');
}

describe('GET /api/v1/anomalies workspace access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkDashboardFeatureGate.mockResolvedValue(null);
    mocks.listAnomalies.mockResolvedValue([{ id: 'anomaly-1' }]);
  });

  it('lists anomalies for a workspace with product access', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      anomalies: [{ id: 'anomaly-1' }],
    });
    expect(mocks.checkDashboardFeatureGate).toHaveBeenCalledWith('builder-1', 'advanced_rules');
  });

  it('keeps the historical empty-list response for restricted workspaces', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValue(
      NextResponse.json({ error: { code: 'FEATURE_NOT_AVAILABLE' } }, { status: 403 }),
    );

    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      anomalies: [],
      feature_disabled: true,
    });
    expect(mocks.listAnomalies).not.toHaveBeenCalled();
  });

  it('fails closed when entitlement cannot be verified', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValue(
      NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
    );

    const response = await GET(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(mocks.listAnomalies).not.toHaveBeenCalled();
  });
});
