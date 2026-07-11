// Client-side /api/v1 access for dashboard pages.
//
// The dashboard's browser session is a single cookie shared by every tab, so
// a login in one tab silently re-points the whole browser at another account.
// Every dashboard API call therefore declares which org's PAGE it comes from
// (x-pylva-org, derived from the /o/{slug}/... URL); the middleware verifies
// the session user's membership in that org and rejects mismatches with 403
// ORG_MISMATCH instead of silently reading/writing the other account's data.
//
// Use apiFetch for fetch calls and orgEventSource for SSE. Both carry a
// narrowing-only page user fingerprint as well as the org slug.

import {
  ORG_HEADER,
  PAGE_SESSION_HEADER,
  PAGE_SESSION_META_NAME,
  withDashboardContext,
} from './request-context.js';

export { withDashboardContext } from './request-context.js';
/** window CustomEvent fired when a response reveals the session changed accounts. */
export const SESSION_CHANGED_EVENT = 'pylva:session-changed';
export interface SessionChangedDetail {
  code: 'SESSION_MISMATCH' | 'ORG_MISMATCH' | 'DASHBOARD_CONTEXT_REQUIRED';
}

const ORG_PATH_PATTERN = /^\/o\/([^/]+)(?:\/|$)/;

/** Org slug of the page currently loaded in this tab, from the URL. */
export function activeOrgSlug(): string | null {
  if (typeof window === 'undefined') return null;
  const match = ORG_PATH_PATTERN.exec(window.location.pathname);
  return match?.[1] ?? null;
}

/** User fingerprint embedded by the server-rendered dashboard layout. */
export function activePageSession(): string | null {
  if (typeof document === 'undefined') return null;
  return (
    document.querySelector<HTMLMetaElement>(`meta[name="${PAGE_SESSION_META_NAME}"]`)?.content ??
    null
  );
}

function dispatchSessionChanged(code: SessionChangedDetail['code']): void {
  window.dispatchEvent(
    new CustomEvent<SessionChangedDetail>(SESSION_CHANGED_EVENT, { detail: { code } }),
  );
}

interface ApiErrorBody {
  error?: { code?: string };
}

/**
 * fetch() with the page's org attached. On a 403 ORG_MISMATCH response,
 * dispatches SESSION_CHANGED_EVENT (SessionWatcher shows the blocking
 * overlay) and returns the response unchanged so callers' error paths
 * still run.
 */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const slug = activeOrgSlug();
  const pageSession = activePageSession();
  if (slug && !headers.has(ORG_HEADER)) headers.set(ORG_HEADER, slug);
  if (pageSession && !headers.has(PAGE_SESSION_HEADER)) {
    headers.set(PAGE_SESSION_HEADER, pageSession);
  }

  const response = await fetch(input, { ...init, headers });
  if (response.status === 400 || response.status === 403) {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    const code = body?.error?.code;
    if (
      code === 'SESSION_MISMATCH' ||
      code === 'ORG_MISMATCH' ||
      code === 'DASHBOARD_CONTEXT_REQUIRED'
    ) {
      dispatchSessionChanged(code);
    }
  }
  return response;
}

/** EventSource with the page's org attached as a query param. */
export function orgEventSource(path: string): EventSource {
  const url = new URL(path, window.location.origin);
  const slug = activeOrgSlug();
  const pageSession = activePageSession();
  const contextualPath =
    slug && pageSession
      ? withDashboardContext(`${url.pathname}${url.search}`, { orgSlug: slug, pageSession })
      : `${url.pathname}${url.search}`;
  return new EventSource(contextualPath, { withCredentials: true });
}
