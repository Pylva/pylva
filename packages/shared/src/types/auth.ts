// Auth types — spec Section 4.9 + B2a §4.5 (org model additions)
// Decision #4: jose, not NextAuth
// Decision #18: API key format pv_live_{keyId}_{randomPart}
// Decision D5 (B2a): builder = org; users attach via user_builder_memberships

import type { BuilderTier } from './tier.js';

export const ApiKeyScope = {
  /** The only scope minted since migration 048: one key covers the SDK, admin, and import surfaces. */
  UNIVERSAL: 'universal',
  /** @deprecated Pre-046 scope; existing rows are migrated to 'universal'. Kept for straggler tolerance. */
  AGENT_SDK: 'agent_sdk',
  /** @deprecated Pre-046 scope; existing rows are migrated to 'universal'. Kept for straggler tolerance. */
  ADMIN_API: 'admin_api',
  /** @deprecated Pre-046 scope (pv_cli_* keys); existing rows are migrated to 'universal'. */
  DATA_IMPORT: 'data_import',
} as const;

export type ApiKeyScope = (typeof ApiKeyScope)[keyof typeof ApiKeyScope];

export const JwtAudience = {
  DASHBOARD: 'pylva:dashboard',
  PORTAL: 'pylva:portal',
  WEBSOCKET: 'pylva:ws',
} as const;

export type JwtAudience = (typeof JwtAudience)[keyof typeof JwtAudience];

export interface ApiKey {
  id: string;
  key_id: string; // Short ID embedded in key for O(1) lookup
  builder_id: string;
  key_hash: string; // argon2 hash of full key
  scope: ApiKeyScope;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  // B2a: org-owned keys track who created them for audit (any Owner can revoke).
  created_by_user_id?: string | null;
}

// --- B2a: org model ---

export const Role = {
  OWNER: 'owner',
  MEMBER: 'member',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const OAuthProvider = {
  GOOGLE: 'google',
  GITHUB: 'github',
} as const;

export type OAuthProvider = (typeof OAuthProvider)[keyof typeof OAuthProvider];

export const AuthProvider = {
  OAUTH_GOOGLE: 'oauth_google',
  OAUTH_GITHUB: 'oauth_github',
  MAGIC_LINK: 'magic_link',
  MIXED: 'mixed',
} as const;

export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  auth_provider: AuthProvider | null;
  last_login_at: Date | null;
  created_at: Date;
}

export interface BuilderMembership {
  id: string;
  user_id: string;
  builder_id: string;
  role: Role;
  created_at: Date;
}

export interface Invite {
  id: string;
  builder_id: string;
  email: string;
  role: Role;
  token: string;
  expires_at: Date;
  accepted_at: Date | null;
  invited_by_user_id: string;
  created_at: Date;
}

export interface MagicLinkRequest {
  email: string;
}

export interface MagicLinkVerifyResponse {
  ok: true;
  redirect_to: string; // e.g. `/o/{slug}/dashboard`
}

// --- JWT payloads ---

// B2a: the dashboard JWT now carries user + role + active-org (builder) context.
// The audience binding rejects cross-audience replay (I-T1-2).
export interface JwtPayload {
  user_id: string;
  builder_id: string;
  role: Role;
  tier: BuilderTier;
  aud: typeof JwtAudience.DASHBOARD;
  jti: string;
  iat: number;
  exp: number;
}

export interface PortalJwtPayload {
  builder_id: string;
  customer_id: string;
  aud: typeof JwtAudience.PORTAL;
  jti: string;
  iat: number;
  exp: number;
}

export interface WebSocketJwtPayload {
  builder_id: string;
  aud: typeof JwtAudience.WEBSOCKET;
  jti: string;
  iat: number;
  exp: number;
}

export interface ApiKeyValidationResult {
  builder_id: string;
  scope: ApiKeyScope;
}
