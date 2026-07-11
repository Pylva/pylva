// Customer portal types — B4 v2.0 (replaces the B0-stub branding/features
// JSONB shape with typed columns, adds OAuth allowlist + custom-domain
// lifecycle types). Per internal design notes.

// --- Track 4 PR 4.1 (O20): 12-color preset palette ---
// Designer-curated. Locks the primary_color surface to a fixed enum so
// the portal never accepts arbitrary hex from the dashboard form. Keeps
// CSS-injection-impossible by construction.
export const PortalPrimaryColor = {
  INDIGO: '#4f46e5',
  BLUE: '#2563eb',
  CYAN: '#0891b2',
  TEAL: '#0d9488',
  EMERALD: '#059669',
  LIME: '#65a30d',
  AMBER: '#d97706',
  ORANGE: '#ea580c',
  RED: '#dc2626',
  PINK: '#db2777',
  PURPLE: '#9333ea',
  SLATE: '#475569',
} as const;

export type PortalPrimaryColor = (typeof PortalPrimaryColor)[keyof typeof PortalPrimaryColor];

export const PORTAL_PRIMARY_COLOR_VALUES: readonly string[] = Object.values(PortalPrimaryColor);

// --- Display + visibility ---

export const CostDisplayMode = {
  USD: 'usd',
  CREDITS: 'credits',
} as const;

export type CostDisplayMode = (typeof CostDisplayMode)[keyof typeof CostDisplayMode];

export const VisibilityLevel = {
  AGGREGATE_ONLY: 'aggregate_only',
  CATEGORY_MODEL: 'category_model',
  STEP_LEVEL: 'step_level',
} as const;

export type VisibilityLevel = (typeof VisibilityLevel)[keyof typeof VisibilityLevel];

export const InvoiceDetailLevel = {
  SUMMARY_ONLY: 'summary_only',
  LINE_ITEMS: 'line_items',
  FULL: 'full',
} as const;

export type InvoiceDetailLevel = (typeof InvoiceDetailLevel)[keyof typeof InvoiceDetailLevel];

// --- Portal config (one row per builder) ---

// Portal customer OAuth providers. Distinct from the dashboard `OAuthProvider`
// const (auth.ts) — the portal layer adds `generic_oidc` for builders running
// their own identity provider. Dashboard auth never sees generic_oidc.
export const PortalOAuthProvider = {
  GOOGLE: 'google',
  GITHUB: 'github',
  GENERIC_OIDC: 'generic_oidc',
} as const;

export type PortalOAuthProvider = (typeof PortalOAuthProvider)[keyof typeof PortalOAuthProvider];

// Portal OAuth provider config. The `client_secret` is encrypted at rest
// (AES-256-GCM, env-derived key) so this type carries the *opaque* ciphertext
// blob — never the plaintext. The blob shape is `{ ciphertext, iv, tag }`
// per the secret-vault helper introduced in B4-6.
export interface PortalOAuthProviderConfig {
  provider: PortalOAuthProvider;
  client_id: string;
  client_secret_encrypted: string;
  // Generic OIDC only — fetched + validated via discovery probe (D51).
  issuer_url?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
  scopes?: string[];
  enabled: boolean;
}

export interface PortalOAuthConfig {
  providers: PortalOAuthProviderConfig[];
  session_lifetime_hours?: number; // defaults to 8 per b4 plan
}

export interface PortalConfig {
  id: string;
  builder_id: string;
  // Branding
  company_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  // Display
  cost_display_mode: CostDisplayMode;
  credit_label: string; // default 'credits'; surfaced when cost_display_mode === 'credits'
  visibility_level: VisibilityLevel;
  invoice_detail_level: InvoiceDetailLevel;
  show_budget_progress: boolean;
  show_usage_trend: boolean;
  show_invoices: boolean;
  show_non_llm_sources: boolean;
  // Iframe + OAuth
  allowed_iframe_origins: string[];
  oauth_config: PortalOAuthConfig | null;
  created_at: Date;
  updated_at: Date;
}

// --- Portal links (signed URLs / single-use grants) ---

export const PortalLinkType = {
  STANDARD: 'standard',
  SINGLE_USE: 'single_use',
} as const;

export type PortalLinkType = (typeof PortalLinkType)[keyof typeof PortalLinkType];

export const PortalLinkStatus = {
  ACTIVE: 'active',
  USED: 'used',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const;

export type PortalLinkStatus = (typeof PortalLinkStatus)[keyof typeof PortalLinkStatus];

export interface PortalLink {
  id: string;
  builder_id: string;
  customer_id: string;
  jti: string; // JWT ID (unique; revocation key)
  token_hash: string; // sha256 of the JWT — raw token never persisted
  link_type: PortalLinkType;
  status: PortalLinkStatus;
  expires_at: Date; // 24h for standard, fixed expiry for single_use
  first_used_at: Date | null; // single_use: first GET sets this
  grace_expires_at: Date | null; // single_use: first_used_at + 5min (D22)
  revoked_at: Date | null;
  created_by: string; // user_id of dashboard operator who issued the link
  created_at: Date;
}

// --- OAuth access grants (email allowlist) ---

export const PortalAccessGrantStatus = {
  ACTIVE: 'active',
  REVOKED: 'revoked',
} as const;

export type PortalAccessGrantStatus =
  (typeof PortalAccessGrantStatus)[keyof typeof PortalAccessGrantStatus];

export interface PortalAccessGrant {
  id: string;
  builder_id: string;
  customer_id: string; // internal customer UUID
  email: string; // normalized lowercase
  status: PortalAccessGrantStatus;
  created_by: string; // user_id of dashboard operator
  created_at: Date;
  revoked_at: Date | null;
}

// --- Custom domains (self-serve) ---

export const PortalDnsStatus = {
  PENDING_DNS: 'pending_dns',
  DNS_VERIFIED: 'dns_verified',
  FAILED: 'failed',
} as const;

export type PortalDnsStatus = (typeof PortalDnsStatus)[keyof typeof PortalDnsStatus];

export const PortalCertificateStatus = {
  NONE: 'none',
  CERTIFICATE_PENDING: 'certificate_pending',
  ISSUED: 'issued',
  FAILED: 'failed',
} as const;

export type PortalCertificateStatus =
  (typeof PortalCertificateStatus)[keyof typeof PortalCertificateStatus];

export const PortalDomainStatus = {
  PENDING_DNS: 'pending_dns',
  DNS_VERIFIED: 'dns_verified',
  CERTIFICATE_PENDING: 'certificate_pending',
  ACTIVE: 'active',
  FAILED: 'failed',
  DISABLED: 'disabled',
} as const;

export type PortalDomainStatus = (typeof PortalDomainStatus)[keyof typeof PortalDomainStatus];

export interface PortalDomain {
  id: string;
  builder_id: string;
  domain: string; // normalized lowercase punycode
  verification_token: string; // TXT record value the builder must publish
  dns_status: PortalDnsStatus;
  certificate_status: PortalCertificateStatus;
  domain_status: PortalDomainStatus;
  certificate_arn: string | null;
  last_checked_at: Date | null;
  error_detail: string | null;
  created_at: Date;
}
