import { beforeEach, describe, expect, it, vi } from 'vitest';
import { byType, findAll, textContent } from '../_helpers/rsc-tree.js';

const mocks = vi.hoisted(() => ({
  env: { ENABLE_AUTHORITATIVE_BUDGET_CONTROL: true },
  getProductionPosture: vi.fn(),
  withRLS: vi.fn(),
  withBudgetControlReadTransaction: vi.fn(),
  deriveProtectionState: vi.fn(),
  CostSourcesControlTable: function CostSourcesControlTableMock() {
    return null;
  },
  PageHeader: function PageHeaderMock() {
    return null;
  },
}));

vi.mock('@/lib/config', () => ({ env: mocks.env }));
vi.mock('@/lib/budget-control/runtime-posture', () => ({
  getBudgetControlProductionPosture: mocks.getProductionPosture,
}));
vi.mock('@/lib/db/rls', () => ({ withRLS: mocks.withRLS }));
vi.mock('@/lib/budget-control/read-transaction', () => ({
  withBudgetControlReadTransaction: mocks.withBudgetControlReadTransaction,
}));
vi.mock('@/lib/cost-sources/protection', () => ({
  deriveCostSourceProtectionState: mocks.deriveProtectionState,
}));
vi.mock('@/lib/dashboard/headers', () => ({
  readDashboardHeaders: async () => ({
    builderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
    userId: 'user-1',
  }),
}));
vi.mock('@/components/cost-sources/CostSourcesControlTable', () => ({
  CostSourcesControlTable: mocks.CostSourcesControlTable,
}));
vi.mock('@/components/dashboard/PageHeader', () => ({ PageHeader: mocks.PageHeader }));

const { default: CostSourcesPage } =
  await import('../../src/app/o/[slug]/dashboard/cost-sources/page.js');

const sourceRow = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  source_type: 'llm_provider',
  display_name: 'OpenAI',
  slug: 'openai',
  metric: null,
  unit: null,
  price_per_unit: null,
  pricing_tiers: null,
  status: 'healthy',
  tracking_status: 'tracked',
  matchers: ['openai'],
  last_seen_at: null,
  last_discovered_at: null,
  discovery_count: 1,
};

async function renderPage() {
  return CostSourcesPage({ params: Promise.resolve({ slug: 'acme' }) });
}

function renderedSource(element: Awaited<ReturnType<typeof renderPage>>) {
  const tables = findAll(element, byType(mocks.CostSourcesControlTable));
  expect(tables).toHaveLength(1);
  const sources = tables[0]!.props.sources as Array<{ protection_state: string }>;
  expect(sources).toHaveLength(1);
  return sources[0]!;
}

describe('/o/[slug]/dashboard/cost-sources control readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = true;
    mocks.withRLS.mockResolvedValue([sourceRow]);
    mocks.withBudgetControlReadTransaction.mockImplementation(
      async (
        _builderId: string,
        callback: (transaction: { execute: () => Promise<unknown> }) => Promise<unknown>,
      ) =>
        callback({
          execute: async () => [{ control_ready: true, has_active_hard_stop_budget: true }],
        }),
    );
    mocks.deriveProtectionState.mockImplementation(
      (input: {
        authoritativeEnabled: boolean;
        controlReady: boolean;
        hasActiveHardStopBudget: boolean;
      }) =>
        input.authoritativeEnabled && input.controlReady && input.hasActiveHardStopBudget
          ? 'protected'
          : 'tracking_only',
    );
  });

  it('marks a source protected only after the production posture and workspace cutover are ready', async () => {
    mocks.getProductionPosture.mockResolvedValue({
      ready: true,
      reason: null,
      attested: true,
      credential_source: 'dedicated',
    });

    const element = await renderPage();

    expect(mocks.getProductionPosture).toHaveBeenCalledTimes(1);
    expect(mocks.withBudgetControlReadTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.deriveProtectionState).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeEnabled: true, controlReady: true }),
    );
    expect(renderedSource(element).protection_state).toBe('protected');
    expect(textContent(element)).toContain('Control path ready.');
  });

  it('fails closed when the dedicated runtime posture is not ready', async () => {
    mocks.getProductionPosture.mockResolvedValue({
      ready: false,
      reason: 'credential_missing',
      attested: false,
      credential_source: null,
    });

    const element = await renderPage();

    expect(mocks.deriveProtectionState).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeEnabled: false, controlReady: false }),
    );
    expect(renderedSource(element).protection_state).toBe('tracking_only');
    expect(textContent(element)).toContain('has not passed readiness checks');
    expect(textContent(element)).toContain('no source is marked Protected');
    expect(mocks.withBudgetControlReadTransaction).not.toHaveBeenCalled();
  });

  it('fails closed without leaking an unexpected posture error into the dashboard', async () => {
    mocks.getProductionPosture.mockRejectedValue(new Error('secret connection detail'));

    const element = await renderPage();

    expect(mocks.deriveProtectionState).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeEnabled: false, controlReady: false }),
    );
    expect(renderedSource(element).protection_state).toBe('tracking_only');
    expect(textContent(element)).toContain('has not passed readiness checks');
    expect(textContent(element)).not.toContain('secret connection detail');
    expect(mocks.withBudgetControlReadTransaction).not.toHaveBeenCalled();
  });

  it('does not inspect runtime posture while the feature flag is off', async () => {
    mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;

    const element = await renderPage();

    expect(mocks.getProductionPosture).not.toHaveBeenCalled();
    expect(mocks.deriveProtectionState).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeEnabled: false, controlReady: false }),
    );
    expect(renderedSource(element).protection_state).toBe('tracking_only');
    expect(textContent(element)).toContain('Authoritative enforcement is not enabled');
    expect(mocks.withBudgetControlReadTransaction).not.toHaveBeenCalled();
  });

  it('keeps sources tracking-only until this workspace completes its cutover', async () => {
    mocks.getProductionPosture.mockResolvedValue({
      ready: true,
      reason: null,
      attested: true,
      credential_source: 'dedicated',
    });
    mocks.withBudgetControlReadTransaction.mockImplementation(
      async (
        _builderId: string,
        callback: (transaction: { execute: () => Promise<unknown> }) => Promise<unknown>,
      ) =>
        callback({
          execute: async () => [{ control_ready: false, has_active_hard_stop_budget: true }],
        }),
    );

    const element = await renderPage();

    expect(mocks.deriveProtectionState).toHaveBeenCalledWith(
      expect.objectContaining({ authoritativeEnabled: true, controlReady: false }),
    );
    expect(renderedSource(element).protection_state).toBe('tracking_only');
    expect(textContent(element)).toContain('has not completed its enforcement cutover');
  });
});
