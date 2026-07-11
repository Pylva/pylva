// B2a — OAuth provider configuration + user upsert (arctic v2).
// Both GitHub (primary — D10) and Google are modeled; state cookie uses
// HMAC-signed random, verified on callback.

import crypto from 'node:crypto';
import { OAuth2Tokens } from 'arctic';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../config.js';
import {
  AuthProvider,
  type AuthProvider as AuthProviderType,
  OAuthProvider,
  type OAuthProvider as OAuthProviderType,
} from '@pylva/shared';
import { eq } from 'drizzle-orm';
import { externalFetch, type EgressTarget } from '../external-egress.js';
import { encodeOAuthStateValue } from './post-auth-redirect.js';

export const OAUTH_STATE_COOKIE = 'pylva_oauth_state';
export const OAUTH_NONCE_COOKIE = 'pylva_oauth_nonce';
export const OAUTH_PKCE_COOKIE = 'pylva_oauth_pkce';
/** Every OAuth flow cookie starts with this — used to sweep-clear stale flows. */
export const OAUTH_COOKIE_PREFIX = 'pylva_oauth';

/**
 * Per-flow cookie names, suffixed with a digest of the state value. With the
 * fixed names above, starting a second login (e.g. signing into another
 * account in a new tab) clobbered the first flow's state/PKCE cookies and its
 * callback failed validation. Suffixing isolates concurrent flows; the
 * callback re-derives the names from its `state` query param.
 */
export function oauthCookieNames(stateRaw: string): {
  state: string;
  nonce: string;
  pkce: string;
} {
  const id = crypto.createHash('sha256').update(stateRaw).digest('hex').slice(0, 16);
  return {
    state: `${OAUTH_STATE_COOKIE}.${id}`,
    nonce: `${OAUTH_NONCE_COOKIE}.${id}`,
    pkce: `${OAUTH_PKCE_COOKIE}.${id}`,
  };
}

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  callbackUrl: string;
  egressTarget: EgressTarget;
}

function buildCallbackUrl(provider: OAuthProviderType): string {
  return `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/auth/oauth/${provider}/callback`;
}

function providerConfig(provider: OAuthProviderType): OAuthProviderConfig {
  if (provider === OAuthProvider.GITHUB) {
    if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) {
      throw new Error('[auth.oauth] GITHUB_OAUTH_CLIENT_ID / _SECRET are not set');
    }
    return {
      clientId: env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      callbackUrl: buildCallbackUrl(provider),
      egressTarget: 'github',
    };
  }

  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('[auth.oauth] GOOGLE_OAUTH_CLIENT_ID / _SECRET are not set');
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    callbackUrl: buildCallbackUrl(provider),
    egressTarget: 'google_oauth',
  };
}

function createPkceChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

export class OAuthProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: OAuthProviderType,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'OAuthProviderError';
  }
}

export function createOAuthAuthorizationUrl(
  provider: OAuthProviderType,
  state: string,
  codeVerifier: string,
): URL {
  const cfg = providerConfig(provider);
  const scopes =
    provider === OAuthProvider.GITHUB
      ? ['read:user', 'user:email']
      : ['openid', 'email', 'profile'];
  const url = new URL(cfg.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', createPkceChallenge(codeVerifier));
  return url;
}

export async function exchangeOAuthCode(
  provider: OAuthProviderType,
  code: string,
  codeVerifier: string,
): Promise<OAuth2Tokens> {
  const cfg = providerConfig(provider);
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', cfg.clientId);
  body.set('client_secret', cfg.clientSecret);
  body.set('code', code);
  body.set('redirect_uri', cfg.callbackUrl);
  body.set('code_verifier', codeVerifier);

  const res = await externalFetch({
    target: cfg.egressTarget,
    url: cfg.tokenUrl,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Pylva',
    },
    body: body.toString(),
    timeoutMs: 10_000,
  });

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    throw new OAuthProviderError('token response was not JSON', provider, res.status);
  }

  if (res.status < 200 || res.status >= 300 || typeof data.error === 'string') {
    throw new OAuthProviderError(
      'token exchange rejected',
      provider,
      res.status,
      typeof data.error === 'string' ? data.error : undefined,
    );
  }

  return new OAuth2Tokens(data);
}

// --- State cookie (I-T1-4) ---

// Dedicated OAuth-state HMAC key, decoupled from the argon2 password pepper.
// Falls back to ARGON2_SECRET when OAUTH_STATE_SECRET is unset (back-compat).
function oauthStateSecret(): string {
  return env.OAUTH_STATE_SECRET ?? env.ARGON2_SECRET;
}

export function generateOAuthState(next?: string | null): { raw: string; hmac: string } {
  const nonce = crypto.randomBytes(32).toString('hex');
  const raw = encodeOAuthStateValue(nonce, next);
  const hmac = crypto.createHmac('sha256', oauthStateSecret()).update(raw).digest('hex');
  return { raw, hmac };
}

export function verifyOAuthState(raw: string, hmac: string): boolean {
  const expected = crypto.createHmac('sha256', oauthStateSecret()).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hmac, 'hex'));
  } catch {
    return false;
  }
}

// --- User upsert ---

export interface OAuthProfile {
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  provider: OAuthProviderType;
}

export interface UpsertUserResult {
  userId: string;
  isNew: boolean;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  previousAuthProvider: AuthProviderType | null;
}

/**
 * Find user by email (CITEXT — case-insensitive), create if absent.
 * If the user exists with a different auth_provider, update to 'mixed'
 * (edge-case §5.4 "OAuth email already exists from magic-link").
 */
export async function upsertUserFromOAuth(profile: OAuthProfile): Promise<UpsertUserResult> {
  const authProvider: AuthProviderType =
    profile.provider === OAuthProvider.GITHUB
      ? AuthProvider.OAUTH_GITHUB
      : AuthProvider.OAUTH_GOOGLE;

  const existing = await db
    .select({
      id: users.id,
      auth_provider: users.auth_provider,
      display_name: users.display_name,
      avatar_url: users.avatar_url,
    })
    .from(users)
    .where(eq(users.email, profile.email))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0]!;
    const existingProvider = row.auth_provider as AuthProviderType | null;
    const nextProvider: AuthProviderType =
      existingProvider === null || existingProvider === authProvider
        ? authProvider
        : AuthProvider.MIXED;
    await db
      .update(users)
      .set({
        auth_provider: nextProvider,
        display_name: row.display_name ?? profile.displayName,
        avatar_url: row.avatar_url ?? profile.avatarUrl,
        last_login_at: new Date(),
      })
      .where(eq(users.id, row.id));
    return {
      userId: row.id,
      isNew: false,
      email: profile.email,
      displayName: row.display_name ?? profile.displayName,
      avatarUrl: row.avatar_url ?? profile.avatarUrl,
      previousAuthProvider: existingProvider,
    };
  }

  const inserted = await db
    .insert(users)
    .values({
      email: profile.email,
      display_name: profile.displayName,
      avatar_url: profile.avatarUrl,
      auth_provider: authProvider,
      last_login_at: new Date(),
    })
    .returning({ id: users.id });
  return {
    userId: inserted[0]!.id,
    isNew: true,
    email: profile.email,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    previousAuthProvider: null,
  };
}
