import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const mocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  removeChannel: vi.fn(),
  withRLS: vi.fn(async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({ tx: true }),
  ),
  ctx: {
    builderId: '00000000-0000-0000-0000-000000000001',
    userId: 'user-A',
    role: 'owner',
  },
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({ ...mocks.ctx }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  Role: { OWNER: 'owner', MEMBER: 'member' },
  withRole: () => null,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/rules/repository', () => ({
  removeChannel: mocks.removeChannel,
}));

const { DELETE } = await import('../../src/app/api/v1/rules/[id]/channels/[channel_id]/route.js');

function request(): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/rule-A/channels/channel-A', {
    method: 'DELETE',
  });
}

const params = {
  params: Promise.resolve({
    id: 'rule-A',
    channel_id: 'channel-A',
  }),
};

describe('DELETE /api/v1/rules/[id]/channels/[channel_id]', () => {
  beforeEach(() => {
    mocks.auditLog.mockReset();
    mocks.removeChannel.mockReset();
    mocks.withRLS.mockClear();
    mocks.ctx.builderId = '00000000-0000-0000-0000-000000000001';
    mocks.ctx.userId = 'user-A';
    mocks.ctx.role = 'owner';
  });

  it('passes builder id, path rule id, and channel id to removeChannel', async () => {
    mocks.removeChannel.mockResolvedValue(true);

    const response = await DELETE(request(), params);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.removeChannel).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'rule-A',
      'channel-A',
    );
  });

  it('returns 404 and skips audit logging when the scoped delete finds no channel', async () => {
    mocks.removeChannel.mockResolvedValue(false);

    const response = await DELETE(request(), params);

    expect(response.status).toBe(404);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    expect(mocks.withRLS).not.toHaveBeenCalled();
  });

  it('audit-logs only after a successful scoped delete', async () => {
    mocks.removeChannel.mockResolvedValue(true);

    const response = await DELETE(request(), params);

    expect(response.status).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        builder_id: '00000000-0000-0000-0000-000000000001',
        actor_type: 'user',
        actor_id: 'user-A',
        action: 'rule.channel_remove',
        resource_type: 'rule_alert_channel',
        resource_id: 'channel-A',
        details: { rule_id: 'rule-A' },
      }),
    );
  });
});
