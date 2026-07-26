import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import crypto from 'node:crypto';
import type { BuilderAccessState, BuilderPlan, EntitlementSource } from '@pylva/shared';

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

async function setEntitlement(input: {
  plan: BuilderPlan | null;
  accessState: BuilderAccessState;
  source: EntitlementSource | null;
}): Promise<void> {
  await sql`
    UPDATE builders
    SET tier = ${input.plan},
        access_state = ${input.accessState},
        entitlement_source = ${input.source}
    WHERE id = ${builderId}
  `;
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  const [builder] = await sql<{ id: string }[]>`
    INSERT INTO builders (
      email,
      name,
      tier,
      access_state,
      entitlement_source,
      slug
    )
    VALUES (
      ${`portal-entitlement-${crypto.randomBytes(4).toString('hex')}@test.com`},
      'Portal Entitlement Test',
      NULL,
      'active',
      'self_hosted',
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

  it('allows portal access for active self-hosted and paid entitlements', async () => {
    await setEntitlement({ plan: null, accessState: 'active', source: 'self_hosted' });
    await expect(checkPortalEntitlement(builderId)).resolves.toBeNull();

    await setEntitlement({ plan: 'pro', accessState: 'active', source: 'admin' });
    await expect(checkPortalEntitlement(builderId)).resolves.toBeNull();

    await setEntitlement({ plan: 'scale', accessState: 'active', source: 'admin' });
    await expect(checkPortalEntitlement(builderId)).resolves.toBeNull();
  });

  it('denies an otherwise valid existing portal token after suspension', async () => {
    await setEntitlement({ plan: null, accessState: 'suspended', source: 'stripe' });

    const response = await getPortalOverviewRoute(portalRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('FEATURE_NOT_AVAILABLE');
    expect(rangeMock).not.toHaveBeenCalled();
    expect(overviewMock).not.toHaveBeenCalled();
    expect(byModelMock).not.toHaveBeenCalled();
  });
});
