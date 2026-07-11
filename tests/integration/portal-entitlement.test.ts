import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import crypto from 'node:crypto';
import { type BuilderTier } from '@pylva/shared';

const authMock = vi.fn();
const overviewMock = vi.fn();
const byModelMock = vi.fn();
const rangeMock = vi.fn();

vi.mock('../../src/lib/portal/auth.js', () => ({
  authenticatePortalToken: authMock,
}));

vi.mock('../../src/lib/portal/data.js', () => ({
  getPortalOverview: overviewMock,
  getPortalBreakdownByModel: byModelMock,
  resolvePortalRange: rangeMock,
}));

const { checkPortalEntitlement } = await import('../../src/lib/portal/entitlement.js');
const { GET: getPortalOverviewRoute } = await import('../../src/app/api/portal/overview/route.js');

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

let sql: ReturnType<typeof postgres>;
let builderId: string;

function portalRequest(): import('next/server.js').NextRequest {
  return new Request(
    'http://localhost/api/portal/overview?token=valid-existing-token',
  ) as unknown as import('next/server.js').NextRequest;
}

async function setTier(tier: BuilderTier): Promise<void> {
  await sql`UPDATE builders SET tier = ${tier} WHERE id = ${builderId}`;
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  const [builder] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (
      ${`portal-entitlement-${crypto.randomBytes(4).toString('hex')}@test.com`},
      'Portal Entitlement Test',
      'free',
      ${`portal-entitlement-${crypto.randomBytes(4).toString('hex')}`}
    )
    RETURNING id
  `;
  builderId = builder!.id;
});

afterAll(async () => {
  await sql`DELETE FROM builders WHERE id = ${builderId}`;
  await sql.end();
});

describe('portal entitlement integration', () => {
  beforeEach(() => {
    authMock.mockReset();
    overviewMock.mockReset();
    byModelMock.mockReset();
    rangeMock.mockReset();
    authMock.mockResolvedValue({
      kind: 'ok',
      ctx: {
        builderId,
        customerId: 'customer-1',
        jti: 'jti-1',
        linkId: 'link-1',
        sessionExpiresAt: new Date('2026-07-01T12:00:00Z'),
      },
    });
    rangeMock.mockResolvedValue({
      from: new Date('2026-07-01T00:00:00Z'),
      to: new Date('2026-07-01T12:00:00Z'),
      source: 'month_to_date',
    });
    overviewMock.mockResolvedValue({ total_cost_usd: 1.23, event_count: 2 });
    byModelMock.mockResolvedValue([]);
  });

  it('allows portal access for every self-host tier using the real builder row', async () => {
    await setTier('free');
    await expect(checkPortalEntitlement(builderId)).resolves.toBeNull();

    await setTier('pro');
    await expect(checkPortalEntitlement(builderId)).resolves.toBeNull();

    await setTier('scale');
    await expect(checkPortalEntitlement(builderId)).resolves.toBeNull();
  });

  it('keeps an otherwise valid existing portal token usable after downgrade to Free', async () => {
    await setTier('free');

    const response = await getPortalOverviewRoute(portalRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      overview: { total_cost_usd: 1.23, event_count: 2 },
      breakdown: { by_model: [] },
    });
    expect(rangeMock).toHaveBeenCalledOnce();
    expect(overviewMock).toHaveBeenCalledOnce();
    expect(byModelMock).not.toHaveBeenCalled();
  });
});
