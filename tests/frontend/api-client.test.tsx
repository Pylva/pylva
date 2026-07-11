import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, orgEventSource, withDashboardContext } from '@/lib/dashboard/api-client';

const PAGE_SESSION = '0123456789abcdef';

function installPageSessionMeta(): void {
  const meta = document.createElement('meta');
  meta.name = 'pylva-page-session';
  meta.content = PAGE_SESSION;
  document.head.append(meta);
}

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class FakeEventSource {
  static lastUrl: string | null = null;
  static lastInit: EventSourceInit | undefined;

  constructor(url: string, init?: EventSourceInit) {
    FakeEventSource.lastUrl = url;
    FakeEventSource.lastInit = init;
  }
}

describe('apiFetch', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    window.history.pushState({}, '', '/o/org-a/dashboard');
    installPageSessionMeta();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector('meta[name="pylva-page-session"]')?.remove();
  });

  it('attaches the page org from the /o/{slug} URL as x-pylva-org', async () => {
    await apiFetch('/api/v1/costs');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(input).toBe('/api/v1/costs');
    expect(new Headers(init.headers).get('x-pylva-org')).toBe('org-a');
    expect(new Headers(init.headers).get('x-pylva-page-session')).toBe(PAGE_SESSION);
  });

  it('sends no org header outside /o/{slug} pages', async () => {
    window.history.pushState({}, '', '/login');

    await apiFetch('/api/v1/costs');

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(new Headers(init.headers).has('x-pylva-org')).toBe(false);
  });

  it('dispatches pylva:session-changed on a 403 ORG_MISMATCH response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'ORG_MISMATCH' } }));
    const listener = vi.fn();
    window.addEventListener('pylva:session-changed', listener);

    const response = await apiFetch('/api/v1/costs');

    expect(response.status).toBe(403);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('pylva:session-changed', listener);
  });

  it('does not dispatch pylva:session-changed for other 403 codes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: { code: 'INSUFFICIENT_PERMISSIONS' } }));
    const listener = vi.fn();
    window.addEventListener('pylva:session-changed', listener);

    await apiFetch('/api/v1/costs');

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('pylva:session-changed', listener);
  });
});

describe('withDashboardContext', () => {
  it('appends both selectors to a bare path', () => {
    expect(
      withDashboardContext('/api/v1/webhooks/test', {
        orgSlug: 'org-a',
        pageSession: PAGE_SESSION,
      }),
    ).toBe(`/api/v1/webhooks/test?pylva_org=org-a&pylva_page_session=${PAGE_SESSION}`);
  });

  it('preserves an existing query while appending both selectors', () => {
    expect(
      withDashboardContext('/api/v1/costs?window=30d', {
        orgSlug: 'org-a',
        pageSession: PAGE_SESSION,
      }),
    ).toBe(`/api/v1/costs?window=30d&pylva_org=org-a&pylva_page_session=${PAGE_SESSION}`);
  });
});

describe('orgEventSource', () => {
  beforeEach(() => {
    FakeEventSource.lastUrl = null;
    FakeEventSource.lastInit = undefined;
    vi.stubGlobal('EventSource', FakeEventSource);
    window.history.pushState({}, '', '/o/org-a/dashboard');
    installPageSessionMeta();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.querySelector('meta[name="pylva-page-session"]')?.remove();
  });

  it('appends the page org as a pylva_org query param', () => {
    orgEventSource('/api/v1/costs/stream');

    expect(FakeEventSource.lastUrl).toBe(
      `/api/v1/costs/stream?pylva_org=org-a&pylva_page_session=${PAGE_SESSION}`,
    );
    expect(FakeEventSource.lastInit).toEqual({ withCredentials: true });
  });

  it('leaves the path unchanged outside /o/{slug} pages', () => {
    window.history.pushState({}, '', '/login');

    orgEventSource('/api/v1/costs/stream');

    expect(FakeEventSource.lastUrl).toBe('/api/v1/costs/stream');
  });
});
