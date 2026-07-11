// Standard test setup for `/api/v1/*` dashboard route handlers.
// Mocks readBuilderContextFromDashboard, withRole, withRLS, auditLog —
// the four imports every dashboard handler reaches for.
//
// Usage (call BEFORE the `await import(...)` of the route under test):
//
//   import { setupDashboardRouteMocks } from '../_helpers/dashboard-route-mock';
//
//   const dashboardMocks = setupDashboardRouteMocks({
//     builderId: 'b-1',
//     role: 'owner',
//   });
//
//   const { POST } = await import('../../src/app/api/v1/.../route.js');
//
//   it('audit-logs on success', async () => {
//     // ... drive the route ...
//     expect(dashboardMocks.auditLogMock).toHaveBeenCalledWith(
//       expect.anything(),
//       expect.objectContaining({ action: 'rule.activated' }),
//     );
//   });
//
// Note: this helper sets up vi.mock calls eagerly. Because vi.mock is
// hoisted, you must import this helper at the TOP of the test file
// (above the `await import(...)` of the route).

import { vi } from 'vitest';

export interface DashboardRouteMockOptions {
  builderId?: string;
  userId?: string;
  role?: 'owner' | 'member';
}

export interface DashboardRouteMockHandles {
  auditLogMock: ReturnType<typeof vi.fn>;
  /** The withRLS mock — pass-through tx that callers can stub further. */
  withRLSMock: ReturnType<typeof vi.fn>;
  /** Mutate to control the auth context returned per request. */
  ctx: { builderId: string; userId: string; role: 'owner' | 'member' };
}

export function setupDashboardRouteMocks(
  opts: DashboardRouteMockOptions = {},
): DashboardRouteMockHandles {
  const ctx = {
    builderId: opts.builderId ?? '00000000-0000-0000-0000-000000000001',
    userId: opts.userId ?? 'u-1',
    role: opts.role ?? ('owner' as const),
  };

  const auditLogMock = vi.fn();
  const withRLSMock = vi.fn(async (_b: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb({
      // Common chain stubs — extend per-test if needed.
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
  );

  vi.mock('../../src/lib/auth/builder-context.js', () => ({
    readBuilderContextFromDashboard: () => ({ ...ctx }),
  }));
  vi.mock('../../src/lib/auth/middleware.js', () => ({
    Role: { OWNER: 'owner', MEMBER: 'member' },
    withRole: () => null, // pass — caller can override per test
  }));
  vi.mock('../../src/lib/auth/audit-log.js', () => ({
    auditLog: auditLogMock,
  }));
  vi.mock('../../src/lib/db/rls.js', () => ({
    withRLS: withRLSMock,
  }));

  return { auditLogMock, withRLSMock, ctx };
}

/**
 * Build a minimal NextRequest for POST/PATCH/DELETE handlers.
 * Provide `body` to set a JSON body; provide `query` to set
 * `searchParams`; both default to empty.
 */
export function makeDashboardRequest(
  opts: {
    url?: string;
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  } = {},
): import('next/server.js').NextRequest {
  const url = new URL(opts.url ?? 'http://localhost/api/v1/test');
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const init: RequestInit = { method: opts.method ?? 'POST' };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(url, init) as unknown as import('next/server.js').NextRequest;
}
