import { beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetActivityPage, BUDGET_FIXTURE_IDS } from '../_helpers/budget-activity-fixtures.js';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  context: {
    builderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId: 'user-1',
    role: 'owner',
  },
  warn: vi.fn(),
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContextFromDashboard: () => ({ ...mocks.context }),
}));
vi.mock('../../src/lib/budget-activity/read-model.js', () => ({
  listBudgetActivity: mocks.list,
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ warn: mocks.warn }) },
}));

const { GET } = await import('../../src/app/api/v1/budget-activity/route.js');

function request(query = '') {
  return new Request(`http://localhost/api/v1/budget-activity${query}`, {
    method: 'GET',
  }) as unknown as import('next/server.js').NextRequest;
}

describe('GET /api/v1/budget-activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(budgetActivityPage());
  });

  it('uses only the authenticated tenant and returns non-cacheable PostgreSQL activity', async () => {
    const response = await GET(
      request(
        `?builder_id=attacker&status=refused&trace_id=${BUDGET_FIXTURE_IDS.trace}&page_size=10`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(mocks.list).toHaveBeenCalledWith(
      BUDGET_FIXTURE_IDS.builder,
      expect.objectContaining({
        status: 'refused',
        trace_id: BUDGET_FIXTURE_IDS.trace,
        page_size: 10,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({ authority: 'postgresql' });
  });

  it('returns a structured 400 for every malformed filter', async () => {
    const response = await GET(request('?page_size=101'));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', param: 'page_size' },
    });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('contains PostgreSQL failures behind a stable 503', async () => {
    const secret = 'postgres://operator:password@internal/authority';
    const hostile = Object.create(null, {
      message: {
        get: () => {
          throw new Error('message inspected');
        },
      },
      toString: {
        value: () => {
          throw new Error('stringified');
        },
      },
      secret: { value: secret, enumerable: true },
    });
    mocks.list.mockRejectedValue(hostile);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Budget activity is temporarily unavailable',
      },
    });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = mocks.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({
      builder_id: BUDGET_FIXTURE_IDS.builder,
      actor_id: 'user-1',
      error_code: 'budget_activity_unavailable',
    });
    expect(fields['error_ref']).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u));
    expect(fields).not.toHaveProperty('error');
    expect(`${JSON.stringify(fields)} ${message}`).not.toContain(secret);
  });
});
