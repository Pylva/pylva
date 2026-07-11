// SEO metadata contract for the app shell (login, portal, 404, dashboard
// layout, global error). These pages are the public repo's whole web surface;
// the hosted marketing site carries its own metadata in the internal overlay.

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Sever heavy server-only imports so the page modules load in jsdom. The
// mocks only need to satisfy module resolution — the assertions below touch
// nothing but the `metadata` exports (and GlobalError's render output).
// The root layout reads env.PUBLIC_SITE_URL at module scope; t3-env throws in
// a jsdom ("client") context, so give it a synthetic value.
vi.mock('../../src/lib/config', () => ({ env: { PUBLIC_SITE_URL: 'https://pylva.test' } }));
vi.mock('../../src/components/dashboard/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../../src/components/dashboard/TopBar', () => ({ TopBar: () => null }));
vi.mock('../../src/components/dashboard/BrokenSourcesBanner', () => ({
  BrokenSourcesBanner: () => null,
}));
vi.mock('../../src/lib/dashboard/headers', () => ({
  readDashboardHeaders: vi.fn(async () => ({ builderId: 'b-1', pathname: '/' })),
}));
vi.mock('../../src/lib/analytics/page-view-beacon', () => ({ PageViewBeacon: () => null }));
vi.mock('../../src/lib/portal/auth', () => ({ authenticatePortalToken: vi.fn() }));
vi.mock('../../src/lib/portal/entitlement', () => ({ checkPortalEntitlement: vi.fn() }));
vi.mock('../../src/lib/portal/data', () => ({
  getPortalBreakdownByModel: vi.fn(),
  getPortalBreakdownByStep: vi.fn(),
  getPortalDailyTrend: vi.fn(),
  getPortalOverview: vi.fn(),
  resolvePortalRange: vi.fn(),
}));
vi.mock('../../src/lib/db/rls', () => ({ withRLS: vi.fn() }));
vi.mock('../../src/lib/db/schema', () => ({ portalConfigs: {} }));

afterEach(cleanup);

describe('app-shell metadata', () => {
  it('login: bare title, description, noindex', async () => {
    const { metadata } = await import('../../src/app/login/page');
    expect(metadata.title).toBe('Sign in');
    expect(String(metadata.description)).toMatch(/Pylva/);
    expect(metadata.robots).toMatchObject({ index: false });
  });

  it('portal: bare title, noindex + nofollow', async () => {
    const { metadata } = await import('../../src/app/portal/page');
    expect(metadata.title).toBe('Usage portal');
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it('dashboard layout: noindex + nofollow for the whole authenticated tree', async () => {
    const { metadata } = await import('../../src/app/o/[slug]/layout');
    expect(metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it('not-found: bare title (template owns the brand suffix)', async () => {
    const { metadata } = await import('../../src/app/not-found');
    expect(metadata.title).toBe('Page not found');
  });

  it('root layout: title template + brand default', async () => {
    const { metadata } = await import('../../src/app/layout');
    expect(metadata.title).toMatchObject({ default: 'Pylva', template: '%s — Pylva' });
    expect(metadata.applicationName).toBe('Pylva');
  });

  it('global error renders a document title', async () => {
    const { default: GlobalError } = await import('../../src/app/global-error');
    render(<GlobalError error={new Error('boom')} reset={() => {}} />);
    const title = document.querySelector('title');
    expect(title?.textContent).toBe('Something went wrong — Pylva');
  });
});
