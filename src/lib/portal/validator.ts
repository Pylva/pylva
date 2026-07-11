// SPDX-License-Identifier: Elastic-2.0
// Portal config validators. Used by the B4-5 dashboard PUT
// /api/v1/portal/config endpoint. Centralizes the typed-column shape so
// the route can persist directly to the Drizzle row.

import * as v from 'valibot';
import {
  CostDisplayMode,
  InvoiceDetailLevel,
  PortalOAuthProvider,
  PORTAL_PRIMARY_COLOR_VALUES,
  VisibilityLevel,
  type PortalConfig,
  type PortalOAuthConfig,
} from '@pylva/shared';

// --- Branding helpers ---

// Hex color: #RGB, #RRGGBB, or #RRGGBBAA. Anything else (gradients,
// var(...) references, hsl()) is rejected at the API boundary so the
// portal renderer can trust the value without sanitization.
const hexColor = v.pipe(
  v.string(),
  v.regex(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/),
);

const httpsUrl = v.pipe(v.string(), v.url(), v.startsWith('https://'));

// Iframe origin = bare scheme://host. Reject paths, queries, fragments —
// the portal frame-ancestors header takes the origin verbatim, and any
// trailing path/query is silently dropped by the browser, so passing it
// through would only mislead the dashboard config preview.
const iframeOrigin = v.pipe(
  v.string(),
  v.url(),
  v.check((u) => {
    try {
      const url = new URL(u);
      return (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === '';
    } catch {
      return false;
    }
  }, 'iframe origin must be a bare scheme://host (no path, query, or fragment)'),
);

const lowercaseTrim = v.transform<string, string>((s) => s.toLowerCase().trim());

// --- OAuth provider config ---

const oauthBaseFields = {
  client_id: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  client_secret_encrypted: v.pipe(v.string(), v.minLength(1)),
  enabled: v.boolean(),
  scopes: v.optional(v.array(v.pipe(v.string(), v.maxLength(100)))),
};

const oauthProviderConfig = v.variant('provider', [
  v.object({
    provider: v.literal(PortalOAuthProvider.GOOGLE),
    ...oauthBaseFields,
  }),
  v.object({
    provider: v.literal(PortalOAuthProvider.GITHUB),
    ...oauthBaseFields,
  }),
  v.object({
    provider: v.literal(PortalOAuthProvider.GENERIC_OIDC),
    ...oauthBaseFields,
    issuer_url: httpsUrl,
    authorization_endpoint: httpsUrl,
    token_endpoint: httpsUrl,
    jwks_uri: httpsUrl,
    userinfo_endpoint: v.optional(httpsUrl),
  }),
]);

const oauthConfig: v.GenericSchema<unknown, PortalOAuthConfig> = v.object({
  providers: v.pipe(v.array(oauthProviderConfig), v.maxLength(10)),
  session_lifetime_hours: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(168)), 8),
});

// --- Portal config (PUT body) ---

export const PORTAL_BRANDING_FIELDS = [
  'logo_url',
  'primary_color',
  'secondary_color',
  'accent_color',
] as const satisfies readonly (keyof PortalConfig)[];

export function hasPortalBrandingFields(config: Partial<PortalConfig>): boolean {
  return PORTAL_BRANDING_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(config, field),
  );
}

// Most fields are optional on PUT — the route merges the patch over the
// existing row. The validator only enforces shape per field, not which
// fields are present.
export const portalConfigUpdateSchema: v.GenericSchema<unknown, Partial<PortalConfig>> = v.partial(
  v.object({
    company_name: v.nullable(v.pipe(v.string(), v.maxLength(120))),
    logo_url: v.nullable(httpsUrl),
    // Track 4 PR 4.1 (O20): primary_color must be one of the 12 preset
    // values. Locks the CSS-injection surface to a known enum.
    primary_color: v.nullable(
      v.pipe(
        v.string(),
        v.check(
          (s) => PORTAL_PRIMARY_COLOR_VALUES.includes(s),
          'primary_color must be one of the 12 preset palette values',
        ),
      ),
    ),
    secondary_color: v.nullable(hexColor),
    accent_color: v.nullable(hexColor),
    cost_display_mode: v.picklist([CostDisplayMode.USD, CostDisplayMode.CREDITS]),
    credit_label: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
    visibility_level: v.picklist([
      VisibilityLevel.AGGREGATE_ONLY,
      VisibilityLevel.CATEGORY_MODEL,
      VisibilityLevel.STEP_LEVEL,
    ]),
    invoice_detail_level: v.picklist([
      InvoiceDetailLevel.SUMMARY_ONLY,
      InvoiceDetailLevel.LINE_ITEMS,
      InvoiceDetailLevel.FULL,
    ]),
    show_budget_progress: v.boolean(),
    show_usage_trend: v.boolean(),
    show_invoices: v.boolean(),
    show_non_llm_sources: v.boolean(),
    allowed_iframe_origins: v.pipe(v.array(iframeOrigin), v.maxLength(10)),
    oauth_config: v.nullable(oauthConfig),
  }),
);

// --- Domain validators ---

// Reject apex domains, localhost, private IPs, internal-only TLDs.
// `v.url` requires a scheme; the dashboard input is bare hostname so we
// validate via a regex + reserved-prefix list. IPv6 addresses are
// pre-rejected by the dot-separated hostname regex.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const RESERVED_HOST_PATTERNS = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^0\./,
  /^169\.254\./,
  /\.local$/,
  /\.localhost$/, // RFC6761 — `acme.localhost` resolves to loopback on most OSes
  /\.internal$/,
  /\.test$/,
  /\.example$/,
  /\.invalid$/,
];

export const portalDomainCreateSchema = v.object({
  domain: v.pipe(
    v.string(),
    v.maxLength(253),
    lowercaseTrim,
    v.regex(HOSTNAME_RE, 'must be a fully-qualified hostname (e.g. usage.acme.com)'),
    v.check(
      (s) => !RESERVED_HOST_PATTERNS.some((re) => re.test(s)),
      'reserved / private / internal hostnames are not allowed',
    ),
  ),
});

// --- Access grants ---

export const portalAccessGrantCreateSchema = v.object({
  customer_id: v.pipe(v.string(), v.uuid()),
  email: v.pipe(v.string(), v.email(), v.maxLength(254), lowercaseTrim),
});
