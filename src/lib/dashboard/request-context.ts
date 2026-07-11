export const ORG_HEADER = 'x-pylva-org';
export const PAGE_SESSION_HEADER = 'x-pylva-page-session';
export const ORG_QUERY_PARAM = 'pylva_org';
export const PAGE_SESSION_QUERY_PARAM = 'pylva_page_session';
export const PAGE_SESSION_META_NAME = 'pylva-page-session';

export interface DashboardPageContext {
  orgSlug: string;
  pageSession: string;
}

/** Add the page-bound org and user marker to navigation-only dashboard URLs. */
export function withDashboardContext(path: string, context: DashboardPageContext): string {
  const url = new URL(path, 'https://pylva.invalid');
  url.searchParams.set(ORG_QUERY_PARAM, context.orgSlug);
  url.searchParams.set(PAGE_SESSION_QUERY_PARAM, context.pageSession);
  return `${url.pathname}${url.search}${url.hash}`;
}
