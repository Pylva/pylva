// F6 (B6/B14) — activation gates. Promotion is the moment a rule starts
// affecting live traffic, so the route re-validates the full rule against
// the create schema (drafts store free-form config), enforces the operator
// kill switch / tier gate / failover consent, requires confirm-by-typing
// the rule name (trimmed on BOTH sides), and heals the legacy post_call
// enforcement default on pre_call-only types so an activated rule is
// actually served to the SDK.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode, RuleEnforcement, RuleStatus, RuleType } from '@pylva/shared';
import { POOLED_TARGETING_MESSAGE } from '../../src/lib/rules/validator.js';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  checkFeatureGate: vi.fn(),
  getRule: vi.fn(),
  isFeatureEnabled: vi.fn(),
  previewRule: vi.fn(),
  promoteRuleStatus: vi.fn(),
  snapshotBackupPrice: vi.fn(),
  updateRule: vi.fn(),
  withRLS: vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  ),
}));

vi.mock('../../src/lib/auth/middleware.js', () => ({
  Role: { OWNER: 'owner', MEMBER: 'member' },
  withRole: (allowed: string[], role: string | null) =>
    role && allowed.includes(role)
      ? null
      : Response.json(
          {
            error: {
              type: 'invalid_request_error',
              code: ErrorCode.INSUFFICIENT_PERMISSIONS,
              message: `Only ${allowed.join(', ')} can perform this action`,
            },
          },
          { status: 403 },
        ),
}));

vi.mock('../../src/lib/auth/tier-enforcement.js', () => ({
  checkFeatureGate: mocks.checkFeatureGate,
}));
vi.mock('../../src/lib/auth/audit-log.js', () => ({ auditLog: mocks.auditLog }));
vi.mock('../../src/lib/db/rls.js', () => ({ withRLS: mocks.withRLS }));
vi.mock('../../src/lib/feature-flags.js', () => ({ isFeatureEnabled: mocks.isFeatureEnabled }));
vi.mock('../../src/lib/rules/backup-price-snapshot.js', () => ({
  snapshotBackupPrice: mocks.snapshotBackupPrice,
}));
vi.mock('../../src/lib/rules/preview.js', () => ({ previewRule: mocks.previewRule }));
vi.mock('../../src/lib/rules/repository.js', () => ({
  getRule: mocks.getRule,
  promoteRuleStatus: mocks.promoteRuleStatus,
  updateRule: mocks.updateRule,
}));
vi.mock('../../src/lib/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ tier: 'pro' }]),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

const { POST } = await import('../../src/app/api/v1/rules/[id]/activate/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const params = { params: Promise.resolve({ id: 'rule-1' }) };

function activateRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/rule-1/activate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-builder-id': BUILDER_ID,
      'x-user-id': 'user-1',
      'x-user-role': 'owner',
    },
    body: JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function draftRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    builder_id: BUILDER_ID,
    type: RuleType.BUDGET_LIMIT,
    enforcement: RuleEnforcement.PRE_CALL,
    name: 'Daily cap',
    enabled: true,
    customer_id: null,
    status: RuleStatus.DRAFT,
    config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' },
    ...overrides,
  };
}

const VALID_ROUTING_CONFIG = {
  scope: 'pooled',
  match: { provider: 'openai', model: 'gpt-4o' },
  route_to: { provider: 'openai', model: 'gpt-4o-mini' },
  fallback: {
    on_cross_provider_auth_error: true,
    on_access_denied: true,
    on_model_not_found: true,
    use_original_model: true,
    skip_same_provider_401: true,
  },
};

const VALID_FAILOVER_CONFIG = {
  customer_id: 'cust_1',
  primary_provider: 'openai',
  backup_provider: 'anthropic',
  enabled: false,
  consent_to_cost_shift: true,
  trigger_error_rate_pct: 50,
  window_seconds: 300,
  recover_error_rate_pct: 10,
  recover_after_seconds: 600,
  recovery_probe_after_seconds: 900,
};

describe('POST /api/v1/rules/[id]/activate — F6 gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkFeatureGate.mockReturnValue(null);
    mocks.isFeatureEnabled.mockResolvedValue(true);
    mocks.snapshotBackupPrice.mockResolvedValue(null);
    mocks.previewRule.mockResolvedValue({
      affected_customers: [{ customer_id: 'cust_1' }],
      total_customers: 4,
      live_traffic_warning: false,
      warnings: [],
    });
    mocks.getRule.mockResolvedValue(draftRule());
    mocks.promoteRuleStatus.mockResolvedValue(draftRule({ status: RuleStatus.ACTIVE }));
    mocks.updateRule.mockImplementation(async (_b: string, _id: string, patch: object) => ({
      ...draftRule(),
      ...patch,
    }));
  });

  it('activates a valid draft', async () => {
    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mocks.promoteRuleStatus).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', RuleStatus.ACTIVE);
  });

  it('refuses to activate a draft whose config fails the create schema, keeping it draft', async () => {
    // Simulator-era legacy draft shape — not a modelRoutingConfig.
    mocks.getRule.mockResolvedValue(
      draftRule({
        type: RuleType.MODEL_ROUTING,
        enforcement: RuleEnforcement.PRE_CALL,
        name: 'Swap gpt-4o',
        config: { from_provider: 'openai', from_model: 'gpt-4o', to_model: 'gpt-4o-mini' },
      }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Swap gpt-4o' }),
      params,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.VALIDATION_ERROR },
    });
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('refuses to activate an empty-config budget draft (dead rule)', async () => {
    mocks.getRule.mockResolvedValue(draftRule({ config: {} }));

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(400);
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('refuses to activate a legacy pooled+targeted draft', async () => {
    mocks.getRule.mockResolvedValue(
      draftRule({
        customer_id: 'cust_1',
        config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'pooled' },
      }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining(POOLED_TARGETING_MESSAGE) },
    });
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('demotes an active rule to draft without confirm_name or schema validation', async () => {
    // Demotion is the safe direction — it must stay available even for
    // rules whose stored config predates stricter validation.
    mocks.getRule.mockResolvedValue(draftRule({ status: RuleStatus.ACTIVE, config: {} }));
    mocks.promoteRuleStatus.mockResolvedValue(draftRule({ config: {} }));

    const response = await POST(activateRequest({ status: RuleStatus.DRAFT }), params);

    expect(response.status).toBe(200);
    expect(mocks.promoteRuleStatus).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', RuleStatus.DRAFT);
  });

  it('rejects activation when confirm_name does not match', async () => {
    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Wrong name' }),
      params,
    );

    expect(response.status).toBe(403);
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('rejects activation when confirm_name is missing entirely', async () => {
    const response = await POST(activateRequest({ status: RuleStatus.ACTIVE }), params);

    expect(response.status).toBe(403);
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('trims BOTH sides: stored names with stray whitespace stay confirmable (B14)', async () => {
    mocks.getRule.mockResolvedValue(draftRule({ name: '  Daily cap  ' }));
    mocks.promoteRuleStatus.mockResolvedValue(
      draftRule({ name: '  Daily cap  ', status: RuleStatus.ACTIVE }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mocks.promoteRuleStatus).toHaveBeenCalled();
  });

  it('returns 503 when the operator kill switch disables advanced rules', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    mocks.getRule.mockResolvedValue(
      draftRule({ type: RuleType.MODEL_ROUTING, config: VALID_ROUTING_CONFIG }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.FEATURE_NOT_AVAILABLE },
    });
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('returns the tier gate response when checkFeatureGate blocks advanced rules', async () => {
    mocks.checkFeatureGate.mockReturnValue(
      Response.json(
        { error: { type: 'invalid_request_error', code: ErrorCode.FEATURE_NOT_AVAILABLE } },
        { status: 403 },
      ),
    );
    mocks.getRule.mockResolvedValue(
      draftRule({ type: RuleType.MODEL_ROUTING, config: VALID_ROUTING_CONFIG }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(403);
    expect(mocks.checkFeatureGate).toHaveBeenCalledWith('pro', 'advanced_rules');
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('rejects failover activation without consent_to_cost_shift', async () => {
    mocks.getRule.mockResolvedValue(
      draftRule({
        type: RuleType.RELIABILITY_FAILOVER,
        config: { ...VALID_FAILOVER_CONFIG, consent_to_cost_shift: false },
      }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(403);
    expect(mocks.promoteRuleStatus).not.toHaveBeenCalled();
  });

  it('persists the backup-price snapshot before promotion', async () => {
    const snapshotConfig = {
      ...VALID_FAILOVER_CONFIG,
      backup_model: 'claude-sonnet-5',
      consent_backup_input_per_1m_usd: 3,
      consent_backup_output_per_1m_usd: 15,
      consent_observed_at: '2026-07-01T00:00:00.000Z',
    };
    mocks.snapshotBackupPrice.mockResolvedValue(snapshotConfig);
    mocks.getRule.mockResolvedValue(
      draftRule({
        type: RuleType.RELIABILITY_FAILOVER,
        config: { ...VALID_FAILOVER_CONFIG, backup_model: 'claude-sonnet-5' },
      }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mocks.updateRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', {
      config: snapshotConfig,
    });
    const snapshotOrder = mocks.updateRule.mock.invocationCallOrder[0]!;
    const promoteOrder = mocks.promoteRuleStatus.mock.invocationCallOrder[0]!;
    expect(snapshotOrder).toBeLessThan(promoteOrder);
  });

  it('heals the legacy post_call enforcement on model_routing before promotion', async () => {
    // Pre-fix drafts were stored with the post_call default; the SDK rules
    // fetch filters enforcement=pre_call, so promoting without the heal
    // activates a rule the SDK never serves.
    mocks.getRule.mockResolvedValue(
      draftRule({
        type: RuleType.MODEL_ROUTING,
        enforcement: RuleEnforcement.POST_CALL,
        config: VALID_ROUTING_CONFIG,
      }),
    );

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mocks.updateRule).toHaveBeenCalledWith(BUILDER_ID, 'rule-1', {
      enforcement: RuleEnforcement.PRE_CALL,
    });
    const healOrder = mocks.updateRule.mock.invocationCallOrder[0]!;
    const promoteOrder = mocks.promoteRuleStatus.mock.invocationCallOrder[0]!;
    expect(healOrder).toBeLessThan(promoteOrder);
  });

  it('does not touch enforcement when it is already correct', async () => {
    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    expect(response.status).toBe(200);
    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it('flags high impact at >=50% of known customers', async () => {
    mocks.previewRule.mockResolvedValue({
      affected_customers: [{ customer_id: 'a' }, { customer_id: 'b' }],
      total_customers: 4,
      live_traffic_warning: false,
      warnings: [],
    });

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    await expect(response.json()).resolves.toMatchObject({
      impact_pct: 50,
      high_impact_warning: true,
    });
  });

  it('does not flag high impact at 49%', async () => {
    mocks.previewRule.mockResolvedValue({
      affected_customers: Array.from({ length: 49 }, (_, i) => ({ customer_id: `c${i}` })),
      total_customers: 100,
      live_traffic_warning: false,
      warnings: [],
    });

    const response = await POST(
      activateRequest({ status: RuleStatus.ACTIVE, confirm_name: 'Daily cap' }),
      params,
    );

    await expect(response.json()).resolves.toMatchObject({
      impact_pct: 49,
      high_impact_warning: false,
    });
  });
});
