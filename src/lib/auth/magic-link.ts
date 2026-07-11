// B2a — magic-link issue + consume. Tokens live in Redis with a 15-min TTL
// (D12). Verify uses GETDEL for atomic single-use (I-T1-5). Redis failure →
// throw AuthDegraded (fail-closed; D13, I-T1-5).
//
// Token format: 32 random bytes, hex-encoded → 64-char URL-safe string.

import crypto from 'node:crypto';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { redisClient } from '../redis/client.js';
import { env } from '../config.js';
import { AuthProvider, type AuthProvider as AuthProviderType } from '@pylva/shared';
import { eq } from 'drizzle-orm';
import { validateAuthNext, type AllowedAuthNextPath } from './post-auth-redirect.js';

const TOKEN_KEY = (token: string) => `magic:${token}`;

export class AuthDegraded extends Error {
  constructor(reason: string) {
    super(`[auth.magic-link] auth service degraded: ${reason}`);
    this.name = 'AuthDegraded';
  }
}

export interface IssueMagicTokenInput {
  email: string;
  next?: string | null;
  pendingInviteToken?: string | null;
}

export interface IssueMagicTokenResult {
  token: string;
  expiresAt: Date;
}

export async function issueMagicToken(input: IssueMagicTokenInput): Promise<IssueMagicTokenResult> {
  const token = crypto.randomBytes(32).toString('hex');
  const ttlSeconds = env.MAGIC_LINK_TTL_SECONDS;
  const next = validateAuthNext(input.next);

  try {
    await redisClient.set(
      TOKEN_KEY(token),
      JSON.stringify({
        email: input.email.toLowerCase(),
        ...(next ? { next } : {}),
        ...(input.pendingInviteToken ? { pendingInviteToken: input.pendingInviteToken } : {}),
      }),
      {
        EX: ttlSeconds,
        NX: true,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthDegraded(`redis set failed: ${msg}`);
  }

  return {
    token,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  };
}

export interface ConsumeMagicTokenResult {
  userId: string;
  email: string;
  isNewUser: boolean;
  next: AllowedAuthNextPath | null;
  pendingInviteToken: string | null;
}

/**
 * Consume a magic-link token atomically (GETDEL). Upserts the user row on
 * first consumption and sets auth_provider accordingly.
 *
 * Throws AuthDegraded on Redis failure (I-T1-5 fail-closed). Returns null if
 * the token has expired or is already consumed.
 */
export async function consumeMagicToken(token: string): Promise<ConsumeMagicTokenResult | null> {
  let raw: string | null = null;
  try {
    // GETDEL is atomic: if the key exists, it returns the value and deletes it.
    raw = (await redisClient.sendCommand(['GETDEL', TOKEN_KEY(token)])) as string | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthDegraded(`redis getdel failed: ${msg}`);
  }
  if (raw === null) return null;

  const payload = JSON.parse(raw) as {
    email: string;
    next?: unknown;
    pendingInviteToken?: unknown;
  };
  const { email } = payload;
  const next = validateAuthNext(typeof payload.next === 'string' ? payload.next : null);
  const pendingInviteToken =
    typeof payload.pendingInviteToken === 'string' &&
    /^[a-f0-9]{64}$/.test(payload.pendingInviteToken)
      ? payload.pendingInviteToken
      : null;

  // Upsert user.
  const existing = await db
    .select({ id: users.id, auth_provider: users.auth_provider })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0]!;
    const existingProvider = row.auth_provider as AuthProviderType | null;
    const nextProvider: AuthProviderType =
      existingProvider === null || existingProvider === AuthProvider.MAGIC_LINK
        ? AuthProvider.MAGIC_LINK
        : AuthProvider.MIXED;
    await db
      .update(users)
      .set({ auth_provider: nextProvider, last_login_at: new Date() })
      .where(eq(users.id, row.id));
    return { userId: row.id, email, isNewUser: false, next, pendingInviteToken };
  }

  const inserted = await db
    .insert(users)
    .values({
      email,
      auth_provider: AuthProvider.MAGIC_LINK,
      last_login_at: new Date(),
    })
    .returning({ id: users.id });

  return { userId: inserted[0]!.id, email, isNewUser: true, next, pendingInviteToken };
}

/**
 * Compose the HTML body for a magic-link email. Deliberately inline (D12 —
 * no new email-template dep). Branded minimally.
 */
export function renderMagicLinkEmail(params: {
  magicUrl: string;
  email: string;
  expiresInMinutes: number;
}): { subject: string; html: string } {
  const safeUrl = params.magicUrl.replace(/"/g, '&quot;');
  const subject = 'Your Pylva sign-in link';
  const html = `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;color:#222">
  <h2 style="font-size:18px">Sign in to Pylva</h2>
  <p>Click the button below to sign in. This link expires in ${params.expiresInMinutes} minutes.</p>
  <p><a href="${safeUrl}" style="display:inline-block;padding:10px 16px;background:#004845;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p>
  <p style="color:#666;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore the email.</p>
</body></html>`;
  return { subject, html };
}
