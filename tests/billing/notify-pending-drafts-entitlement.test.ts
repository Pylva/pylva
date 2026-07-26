import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authorizeBuilderCapability: vi.fn(),
  getBuilderEntitlementForShare: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  send: vi.fn(),
  draftRows: [] as Array<{ builder_id: string; draft_count: number }>,
  ownerRows: [] as Array<{ user_id: string; email: string; builder_id: string }>,
}));

const tables = vi.hoisted(() => ({
  builders: {
    __table: 'builders',
    id: { name: 'id' },
    access_state: { name: 'access_state' },
  },
  invoices: {
    __table: 'invoices',
    builder_id: { name: 'builder_id' },
    status: { name: 'status' },
    created_at: { name: 'created_at' },
  },
  users: {
    __table: 'users',
    id: { name: 'id' },
    email: { name: 'email' },
  },
  memberships: {
    __table: 'memberships',
    user_id: { name: 'user_id' },
    builder_id: { name: 'builder_id' },
    role: { name: 'role' },
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (left: unknown, right: unknown) => ({ left, right }),
  gte: (left: unknown, right: unknown) => ({ left, right }),
  inArray: (left: unknown, right: unknown) => ({ left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

vi.mock('../../src/lib/db/schema.js', () => ({
  builders: tables.builders,
  invoices: tables.invoices,
  users: tables.users,
  userBuilderMemberships: tables.memberships,
}));

vi.mock('../../src/lib/db/client.js', () => ({
  db: { select: mocks.select, transaction: mocks.transaction },
}));

vi.mock('../../src/lib/auth/builder-entitlement.js', () => ({
  authorizeBuilderCapability: mocks.authorizeBuilderCapability,
}));

vi.mock('../../src/lib/db/advisory-locks.js', () => ({
  getBuilderEntitlementForShare:
    mocks.getBuilderEntitlementForShare,
}));

vi.mock('../../src/lib/config.js', () => ({
  env: {
    RESEND_API_KEY: 're_test',
    ALERT_FROM_EMAIL: 'alerts@example.com',
    PYLVA_BACKEND_URL: 'https://app.example.com',
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

const { notifyPendingDrafts } = await import('../../src/lib/billing/notify-pending-drafts.js');

describe('pending draft notification workspace lifecycle gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.draftRows = [{ builder_id: 'builder-a', draft_count: 2 }];
    mocks.ownerRows = [{ user_id: 'owner-a', email: 'owner@example.com', builder_id: 'builder-a' }];
    mocks.select.mockImplementation(() => ({
      from: (table: { __table: string }) => {
        if (table.__table === 'invoices') {
          return {
            innerJoin: () => ({
              where: () => ({
                groupBy: async () => mocks.draftRows,
              }),
            }),
          };
        }
        return {
          innerJoin: () => ({
            where: async () => mocks.ownerRows,
          }),
        };
      },
    }));
    mocks.send.mockResolvedValue({ data: { id: 'email-a' }, error: null });
    mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: true });
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: {
        plan: null,
        access_state: 'active',
        entitlement_source: 'self_hosted',
        has_product_access: true,
        legacy_free: false,
      },
    });
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback({}),
    );
  });

  it('does not resolve owners or send mail for a restricted workspace', async () => {
    mocks.authorizeBuilderCapability.mockResolvedValue({ allowed: false });

    await expect(
      notifyPendingDrafts({ now: new Date('2026-07-01T00:00:00.000Z') }),
    ).resolves.toMatchObject({
      builders_with_drafts: 0,
      skipped_builders_no_product_access: 1,
      owners_notified: 0,
      emails_sent: 0,
    });

    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rechecks immediately before email and drops a workspace suspended after scan', async () => {
    mocks.getBuilderEntitlementForShare.mockResolvedValueOnce({
      ok: true,
      entitlement: {
        plan: null,
        access_state: 'suspended',
        entitlement_source: null,
        has_product_access: false,
        legacy_free: false,
      },
    });

    await expect(
      notifyPendingDrafts({ now: new Date('2026-07-01T00:00:00.000Z') }),
    ).resolves.toMatchObject({
      builders_with_drafts: 1,
      owners_notified: 0,
      emails_sent: 0,
    });

    expect(mocks.authorizeBuilderCapability).toHaveBeenCalledTimes(1);
    expect(mocks.getBuilderEntitlementForShare).toHaveBeenCalledTimes(1);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send while a suspension wins after the initial scan but before the locked read', async () => {
    let signalLockedRead!: () => void;
    const lockedReadStarted = new Promise<void>((resolve) => {
      signalLockedRead = resolve;
    });
    let releaseLockedRead!: () => void;
    const lockedReadRelease = new Promise<void>((resolve) => {
      releaseLockedRead = resolve;
    });
    mocks.getBuilderEntitlementForShare.mockImplementationOnce(
      async () => {
        signalLockedRead();
        await lockedReadRelease;
        return {
          ok: true,
          entitlement: {
            plan: null,
            access_state: 'suspended',
            entitlement_source: null,
            has_product_access: false,
            legacy_free: false,
          },
        };
      },
    );

    const notification = notifyPendingDrafts({
      now: new Date('2026-07-01T00:00:00.000Z'),
    });
    await lockedReadStarted;
    expect(mocks.send).not.toHaveBeenCalled();

    releaseLockedRead();
    await expect(notification).resolves.toMatchObject({
      owners_notified: 0,
      emails_sent: 0,
    });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('holds the locked transaction through the Resend attempt', async () => {
    let transactionFinished = false;
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => {
        const result = await callback({});
        transactionFinished = true;
        return result;
      },
    );
    mocks.send.mockImplementation(async () => {
      expect(transactionFinished).toBe(false);
      return { data: { id: 'email-a' }, error: null };
    });

    await expect(
      notifyPendingDrafts({ now: new Date('2026-07-01T00:00:00.000Z') }),
    ).resolves.toMatchObject({
      owners_notified: 1,
      emails_sent: 1,
    });
    expect(transactionFinished).toBe(true);
  });

  it('locks a multi-workspace owner target in deterministic builder order and sends once', async () => {
    mocks.draftRows = [
      { builder_id: 'builder-b', draft_count: 3 },
      { builder_id: 'builder-a', draft_count: 2 },
    ];
    mocks.ownerRows = [
      {
        user_id: 'owner-a',
        email: 'owner@example.com',
        builder_id: 'builder-b',
      },
      {
        user_id: 'owner-a',
        email: 'owner@example.com',
        builder_id: 'builder-a',
      },
    ];

    await expect(
      notifyPendingDrafts({ now: new Date('2026-07-01T00:00:00.000Z') }),
    ).resolves.toMatchObject({
      builders_with_drafts: 2,
      owners_notified: 1,
      emails_sent: 1,
    });

    expect(
      mocks.getBuilderEntitlementForShare.mock.calls.map(
        (call) => call[1],
      ),
    ).toEqual(['builder-a', 'builder-b']);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]?.[0]).toMatchObject({
      to: 'owner@example.com',
      subject: '5 draft invoices across 2 orgs awaiting review',
    });
  });
});
