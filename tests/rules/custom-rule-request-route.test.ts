import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server.js';

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  withRateLimit: vi.fn(),
  withRLS: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  insertedRequests: [] as Array<Record<string, unknown>>,
  updatedRequests: [] as Array<Record<string, unknown>>,
  statusUpdateError: null as Error | null,
  env: {
    RESEND_API_KEY: 're_test',
    INVITE_FROM_EMAIL: 'team@pylva.test',
    NODE_ENV: 'test',
    // Configured on Pylva Cloud; unset on self-host (see self-host test below).
    CUSTOM_RULE_REQUEST_EMAIL: 'partners@pylva.com' as string | undefined,
  },
}));

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_ID = '22222222-2222-4222-8222-222222222222';

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({
    builderId: BUILDER_ID,
    userId: USER_ID,
    role: 'owner',
  }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  withRateLimit: mocks.withRateLimit,
}));

vi.mock('@/lib/config', () => ({ env: mocks.env }));

vi.mock('@/lib/db/rls', () => ({
  withRLS: mocks.withRLS,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    child: () => ({
      error: mocks.logError,
      warn: mocks.logWarn,
    }),
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.sendEmail };
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, val: unknown) => ({ col: col.name, val }),
}));

vi.mock('@/lib/db/schema', () => ({
  users: {
    __table: 'users',
    id: { name: 'id' },
    email: { name: 'email' },
    display_name: { name: 'display_name' },
  },
  builders: {
    __table: 'builders',
    id: { name: 'id' },
    name: { name: 'name' },
    slug: { name: 'slug' },
    email: { name: 'email' },
    tier: { name: 'tier' },
  },
  customRuleRequests: {
    __table: 'custom_rule_requests',
    id: { name: 'id' },
  },
}));

vi.mock('@/lib/db/client', () => ({
  db: {
    select: () => ({
      from: (table: { __table: string }) => ({
        where: () => ({
          limit: () => {
            if (table.__table === 'users') {
              return Promise.resolve([{ email: 'founder@example.com', displayName: 'Found Er' }]);
            }
            if (table.__table === 'builders') {
              return Promise.resolve([
                {
                  id: BUILDER_ID,
                  name: 'Acme AI',
                  slug: 'acme',
                  email: 'billing@example.com',
                  tier: 'pro',
                },
              ]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
  },
}));

const { POST } = await import('../../src/app/api/v1/rules/custom-request/route.js');

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v1/rules/custom-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeRlsTx() {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        mocks.insertedRequests.push(values);
        return {
          returning: async () => [{ id: REQUEST_ID }],
        };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updatedRequests.push(values);
        return {
          where: async () => {
            if (mocks.statusUpdateError) throw mocks.statusUpdateError;
          },
        };
      },
    }),
  };
}

describe('POST /api/v1/rules/custom-request', () => {
  beforeEach(() => {
    mocks.sendEmail.mockReset().mockResolvedValue({ data: { id: 'email_1' }, error: null });
    mocks.withRateLimit.mockReset().mockResolvedValue(null);
    mocks.withRLS.mockReset().mockImplementation(async (_builderId: string, cb) => cb(makeRlsTx()));
    mocks.logError.mockReset();
    mocks.logWarn.mockReset();
    mocks.insertedRequests.length = 0;
    mocks.updatedRequests.length = 0;
    mocks.statusUpdateError = null;
    mocks.env.RESEND_API_KEY = 're_test';
    mocks.env.NODE_ENV = 'test';
    mocks.env.CUSTOM_RULE_REQUEST_EMAIL = 'partners@pylva.com';
  });

  it('sends an internal request email and a requester receipt with server-side context', async () => {
    mocks.sendEmail.mockImplementation(async () => {
      expect(mocks.insertedRequests).toHaveLength(1);
      return { data: { id: 'email_1' }, error: null };
    });

    const res = await POST(
      request({
        idea: 'Please alert us when one account spends 3x more than its usual hourly baseline.',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({
      ok: true,
      request_id: REQUEST_ID,
      internal_email_sent: true,
      receipt_email_sent: true,
    });
    expect(mocks.insertedRequests[0]).toMatchObject({
      builder_id: BUILDER_ID,
      requester_user_id: USER_ID,
      requester_email: 'founder@example.com',
      requester_display_name: 'Found Er',
      workspace_name: 'Acme AI',
      workspace_slug: 'acme',
      workspace_email: 'billing@example.com',
      workspace_tier: 'pro',
      idea: 'Please alert us when one account spends 3x more than its usual hourly baseline.',
      email_status: 'pending',
      internal_email_sent: false,
      receipt_email_sent: false,
    });
    expect(mocks.updatedRequests[0]).toMatchObject({
      email_status: 'sent',
      internal_email_sent: true,
      receipt_email_sent: true,
      last_email_error: null,
    });
    expect(mocks.withRateLimit).toHaveBeenCalledWith(`custom_rule_request:${USER_ID}`, {
      maxRequests: 1,
      windowMs: 5 * 60 * 1000,
    });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        from: 'team@pylva.test',
        to: ['partners@pylva.com'],
        subject: 'Custom rule request: Acme AI (acme)',
        html: expect.stringContaining('founder@example.com'),
      }),
    );
    expect(mocks.sendEmail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        to: ['founder@example.com'],
        subject: 'We received your custom rule request',
      }),
    );
    const internalEmail = mocks.sendEmail.mock.calls[0]![0] as { html: string };
    expect(internalEmail.html).toContain(BUILDER_ID);
    expect(internalEmail.html).toContain('founder@example.com');
  });

  it('still returns 202 when the post-email status update fails after persistence', async () => {
    mocks.statusUpdateError = new Error('db pool exhausted');

    const res = await POST(
      request({
        idea: 'Please alert us when one account spends 3x more than its usual hourly baseline.',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({
      ok: true,
      request_id: REQUEST_ID,
      internal_email_sent: true,
      receipt_email_sent: true,
    });
    expect(mocks.insertedRequests).toHaveLength(1);
    expect(mocks.updatedRequests[0]).toMatchObject({
      email_status: 'sent',
      internal_email_sent: true,
      receipt_email_sent: true,
      last_email_error: null,
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'db pool exhausted',
        builder_id: BUILDER_ID,
        request_id: REQUEST_ID,
        email_status: 'sent',
        internal_email_sent: true,
        receipt_email_sent: true,
      }),
      'custom rule request email status update failed',
    );
  });

  it.each([
    ['empty', ''],
    ['whitespace', '     \n   '],
    ['too short', 'too short'],
    ['too long', 'x'.repeat(4001)],
    // 5 emoji: String.length is 10 (UTF-16 units) but char_length is 5 (code
    // points). Must be rejected before the INSERT, not blow up the DB CHECK.
    ['too short by code points', '\u{1F600}'.repeat(5)],
  ])('rejects %s requests', async (_label, idea) => {
    const res = await POST(request({ idea }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.param).toBe('idea');
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
    expect(mocks.insertedRequests).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('returns 429 without sending emails when the user is rate-limited', async () => {
    mocks.withRateLimit.mockResolvedValueOnce(
      NextResponse.json(
        {
          error: {
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
            message: 'Rate limit exceeded. Retry after 300 seconds.',
          },
        },
        { status: 429, headers: { 'Retry-After': '300' } },
      ),
    );

    const res = await POST(
      request({
        idea: 'Please create a second custom rule request within the cooldown window.',
      }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('300');
    expect(mocks.withRateLimit).toHaveBeenCalledWith(`custom_rule_request:${USER_ID}`, {
      maxRequests: 1,
      windowMs: 5 * 60 * 1000,
    });
    expect(mocks.insertedRequests).toHaveLength(0);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('keeps the request accepted when only the receipt email fails', async () => {
    mocks.sendEmail
      .mockResolvedValueOnce({ data: { id: 'internal' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'receipt failed' } });

    const res = await POST(
      request({
        idea: 'Create a rule that blocks a model switch when margin would go below 15 percent.',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({
      ok: true,
      request_id: REQUEST_ID,
      internal_email_sent: true,
      receipt_email_sent: false,
    });
    expect(mocks.insertedRequests).toHaveLength(1);
    expect(mocks.updatedRequests[0]).toMatchObject({
      email_status: 'partial_failure',
      internal_email_sent: true,
      receipt_email_sent: false,
      last_email_error: 'receipt failed',
    });
  });

  it('keeps the request accepted when the configured Resend send throws in production', async () => {
    mocks.env.NODE_ENV = 'production';
    mocks.sendEmail.mockRejectedValueOnce(new Error('resend outage'));

    const res = await POST(
      request({
        idea: 'Create a custom rule that alerts on a customer-specific spend spike.',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({
      ok: true,
      request_id: REQUEST_ID,
      internal_email_sent: false,
      receipt_email_sent: false,
    });
    expect(mocks.insertedRequests).toHaveLength(1);
    expect(mocks.updatedRequests[0]).toMatchObject({
      email_status: 'failed',
      internal_email_sent: false,
      receipt_email_sent: false,
      last_email_error: 'resend outage',
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'resend outage',
        builder_id: BUILDER_ID,
      }),
      'custom rule request internal email failed',
    );
  });

  it('does not email Pylva on self-host (CUSTOM_RULE_REQUEST_EMAIL unset)', async () => {
    mocks.env.CUSTOM_RULE_REQUEST_EMAIL = undefined;

    const res = await POST(
      request({
        idea: 'Alert me when a single customer exceeds twice its weekly average spend.',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({
      ok: true,
      request_id: REQUEST_ID,
      internal_email_sent: false,
      receipt_email_sent: true,
    });
    // Request is persisted; the ONLY email sent is the receipt to the requester's
    // own address. Nothing is sent to Pylva — the "no phone home" guarantee.
    expect(mocks.insertedRequests).toHaveLength(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['founder@example.com'] }),
    );
    expect(mocks.updatedRequests[0]).toMatchObject({
      email_status: 'sent',
      internal_email_sent: false,
      receipt_email_sent: true,
    });
  });
});
