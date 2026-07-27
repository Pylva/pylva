import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server.js';
import { anchorHrefs, byType, findAll, textContent } from '../_helpers/rsc-tree.js';

const mocks = vi.hoisted(() => ({
  checkDashboardFeatureGate: vi.fn(),
  readDashboardHeaders: vi.fn(),
  select: vi.fn(),
  SimulatorClient: () => 'SIMULATOR_CLIENT',
}));

vi.mock('@/lib/auth/dashboard-feature-gate', () => ({
  checkDashboardFeatureGate: mocks.checkDashboardFeatureGate,
}));

vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: mocks.readDashboardHeaders,
}));

vi.mock('@/lib/db/client', () => ({
  db: { select: mocks.select },
}));

vi.mock('@/components/dashboard/PageHeader', () => ({
  PageHeader: () => null,
}));

vi.mock('@/components/simulator/SimulatorClient', () => ({
  SimulatorClient: mocks.SimulatorClient,
}));

const { default: SimulatorPage } = await import(
  '../../src/app/o/[slug]/dashboard/simulator/page.js'
);

function pageProps() {
  return { params: Promise.resolve({ slug: 'acme' }) };
}

describe('/o/[slug]/dashboard/simulator authoritative feature gate', () => {
  beforeEach(() => {
    mocks.checkDashboardFeatureGate.mockReset();
    mocks.readDashboardHeaders.mockReset();
    mocks.select.mockReset();
    mocks.readDashboardHeaders.mockResolvedValue({
      builderId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'owner',
      pathname: '/o/acme/dashboard/simulator',
    });
  });

  it('renders the paid-plan lock without reading model pricing when denied', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValue(
      NextResponse.json({ error: { code: 'FEATURE_NOT_AVAILABLE' } }, { status: 403 }),
    );

    const element = await SimulatorPage(pageProps());

    expect(textContent(element)).toContain('Upgrade to Scale');
    expect(textContent(element)).not.toContain('SIMULATOR_CLIENT');
    expect(anchorHrefs(element)).toEqual(['/o/acme/subscription']);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('fails closed without an upgrade CTA when entitlement lookup is unavailable', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValue(
      NextResponse.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 }),
    );

    const element = await SimulatorPage(pageProps());

    expect(textContent(element)).toContain('Workspace entitlement could not be verified');
    expect(anchorHrefs(element)).toEqual([]);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('renders the simulator only after the authoritative gate allows access', async () => {
    mocks.checkDashboardFeatureGate.mockResolvedValue(null);
    const from = vi.fn().mockResolvedValue([]);
    mocks.select.mockReturnValue({ from });

    const element = await SimulatorPage(pageProps());

    expect(findAll(element, byType(mocks.SimulatorClient))).toHaveLength(1);
    expect(mocks.checkDashboardFeatureGate).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'simulator',
    );
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });
});
