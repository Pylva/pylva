import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  addChannel: vi.fn(),
  auditLog: vi.fn(),
  getRule: vi.fn(),
  listChannelsForRule: vi.fn(),
  removeChannel: vi.fn(),
  withRLS: vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  ),
}));

vi.mock('@/lib/rules/repository', () => ({
  addChannel: mocks.addChannel,
  getRule: mocks.getRule,
  listChannelsForRule: mocks.listChannelsForRule,
  removeChannel: mocks.removeChannel,
}));

vi.mock('@/lib/auth/tier-enforcement', () => ({
  checkBuilderFeatureGate: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth/audit-log', () => ({ auditLog: mocks.auditLog }));
vi.mock('@/lib/db/rls', () => ({ withRLS: mocks.withRLS }));
vi.mock('@/lib/auth/middleware', () => ({
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

const collectionRoute = await import('../../src/app/api/v1/rules/[id]/channels/route.js');
const itemRoute = await import('../../src/app/api/v1/rules/[id]/channels/[channel_id]/route.js');

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const RULE_ID = '00000000-0000-4000-8000-000000000101';
const CHANNEL_ID = '00000000-0000-4000-8000-000000000201';
const WEBHOOK_CONFIG_ID = '00000000-0000-4000-8000-000000000301';

function request(
  method: string,
  body?: Record<string, unknown>,
  role: 'owner' | 'member' = 'owner',
): NextRequest {
  return new NextRequest(`http://localhost/api/v1/rules/${RULE_ID}/channels/${CHANNEL_ID}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      'x-builder-id': BUILDER_ID,
      'x-user-id': 'user-1',
      'x-user-role': role,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

const ruleParams = { params: Promise.resolve({ id: RULE_ID }) };
const channelParams = { params: Promise.resolve({ id: RULE_ID, channel_id: CHANNEL_ID }) };

describe('POST /api/v1/rules/[id]/channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRule.mockResolvedValue({ id: RULE_ID });
    mocks.addChannel.mockImplementation(
      async (_builderId: string, input: Record<string, unknown>) => ({
        id: CHANNEL_ID,
        ...input,
      }),
    );
  });

  it('adds a webhook channel by owned webhook config id', async () => {
    const response = await collectionRoute.POST(
      request('POST', { channel: 'webhook', webhook_config_id: WEBHOOK_CONFIG_ID }),
      ruleParams,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      channel: {
        id: CHANNEL_ID,
        rule_id: RULE_ID,
        channel: 'webhook',
        webhook_config_id: WEBHOOK_CONFIG_ID,
      },
    });
    expect(mocks.addChannel).toHaveBeenCalledWith(BUILDER_ID, {
      rule_id: RULE_ID,
      channel: 'webhook',
      enabled: true,
      webhook_config_id: WEBHOOK_CONFIG_ID,
    });
  });

  it('rejects malformed webhook config ids before insertion', async () => {
    const response = await collectionRoute.POST(
      request('POST', { channel: 'webhook', webhook_config_id: 'https://example.com/hook' }),
      ruleParams,
    );

    expect(response.status).toBe(400);
    expect(mocks.addChannel).not.toHaveBeenCalled();
  });

  it('rejects invalid email recipients', async () => {
    const response = await collectionRoute.POST(
      request('POST', { channel: 'email', email_recipients: ['not-an-email'] }),
      ruleParams,
    );

    expect(response.status).toBe(400);
    expect(mocks.addChannel).not.toHaveBeenCalled();
  });

  it('rejects non-Slack webhook URLs for slack channels', async () => {
    const response = await collectionRoute.POST(
      request('POST', { channel: 'slack', slack_webhook_url: 'https://example.com/not-slack' }),
      ruleParams,
    );

    expect(response.status).toBe(400);
    expect(mocks.addChannel).not.toHaveBeenCalled();
  });

  it('allows Slack incoming webhook URLs', async () => {
    const response = await collectionRoute.POST(
      request('POST', {
        channel: 'slack',
        slack_webhook_url: 'https://hooks.slack.com/services/T000/B000/secret',
      }),
      ruleParams,
    );

    expect(response.status).toBe(201);
    expect(mocks.addChannel).toHaveBeenCalledWith(
      BUILDER_ID,
      expect.objectContaining({
        rule_id: RULE_ID,
        channel: 'slack',
        slack_webhook_url: 'https://hooks.slack.com/services/T000/B000/secret',
      }),
    );
  });

  it('forbids members from adding channels', async () => {
    const response = await collectionRoute.POST(
      request('POST', { channel: 'email', email_recipients: ['ops@example.com'] }, 'member'),
      ruleParams,
    );

    expect(response.status).toBe(403);
    expect(mocks.addChannel).not.toHaveBeenCalled();
  });

  it('returns 404 for cross-tenant rule ids', async () => {
    mocks.getRule.mockResolvedValueOnce(null);

    const response = await collectionRoute.POST(
      request('POST', { channel: 'email', email_recipients: ['ops@example.com'] }),
      ruleParams,
    );

    expect(response.status).toBe(404);
    expect(mocks.addChannel).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/rules/[id]/channels/[channel_id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.removeChannel.mockResolvedValue(true);
  });

  it('removes a channel for an owner', async () => {
    const response = await itemRoute.DELETE(request('DELETE'), channelParams);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.removeChannel).toHaveBeenCalledWith(BUILDER_ID, RULE_ID, CHANNEL_ID);
  });

  it('forbids members from removing channels', async () => {
    const response = await itemRoute.DELETE(request('DELETE', undefined, 'member'), channelParams);

    expect(response.status).toBe(403);
    expect(mocks.removeChannel).not.toHaveBeenCalled();
  });

  it('returns 404 when the channel does not belong to the path rule id', async () => {
    mocks.removeChannel.mockResolvedValueOnce(false);

    const response = await itemRoute.DELETE(request('DELETE'), channelParams);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: ErrorCode.NOT_FOUND },
    });
    expect(mocks.removeChannel).toHaveBeenCalledWith(BUILDER_ID, RULE_ID, CHANNEL_ID);
  });
});
