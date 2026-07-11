// B2a — POST /api/v1/auth/magic/request
// Rate-limit `magic:${email}` 5/hour. Generate token (15m TTL in Redis).
// Send via Resend (inline HTML, D12). Fail-closed on Redis outage (I-T1-5).

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { issueMagicToken, AuthDegraded, renderMagicLinkEmail } from '@/lib/auth/magic-link';
import { env } from '@/lib/config';
import { validationError, internalError, authError } from '@/lib/errors';
import { withRateLimit } from '@/lib/auth/middleware';
import { ErrorCode } from '@pylva/shared';
import { logger } from '@/lib/logger';
import { validateAuthNext } from '@/lib/auth/post-auth-redirect';
import { readPendingInviteToken } from '@/lib/auth/pending-invite';

const log = logger.child({ module: 'auth.magic.request' });

const BodySchema = v.object({
  email: v.pipe(v.string(), v.email()),
  next: v.optional(v.string()),
});

const RATE_LIMIT = { maxRequests: 5, windowMs: 60 * 60 * 1000 } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(BodySchema, body);
  if (!parsed.success) {
    return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'email');
  }
  const email = parsed.output.email.toLowerCase();
  const next = validateAuthNext(parsed.output.next);

  // Rate-limit per-email to blunt enumeration + spam.
  const rl = await withRateLimit(`magic:${email}`, RATE_LIMIT);
  if (rl) return rl;

  try {
    const { token, expiresAt } = await issueMagicToken({
      email,
      next,
      pendingInviteToken: readPendingInviteToken(request),
    });
    const magicUrl = `${env.OAUTH_REDIRECT_BASE_URL}/api/v1/auth/magic/verify?token=${encodeURIComponent(token)}`;

    const minutesRemaining = Math.round((expiresAt.getTime() - Date.now()) / 60_000);
    const rendered = renderMagicLinkEmail({ magicUrl, email, expiresInMinutes: minutesRemaining });

    // Resend send — deliberately NOT awaited for the error-path path (Resend
    // retries internally; we return 200 regardless per §5.4 edge case).
    await sendMagicEmail(email, rendered.subject, rendered.html);

    // Never echo whether the email exists (prevents account-existence probing).
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthDegraded) {
      return authError(ErrorCode.INTERNAL_ERROR, 'Auth service degraded — try OAuth');
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg }, 'magic link issue failed');
    return internalError('Could not send magic link');
  }
}

async function sendMagicEmail(to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    // Dev: log the link so the engineer can click it from the server console.
    log.warn({ to }, 'RESEND_API_KEY not set — magic email not sent');
    console.warn(`[DEV] Magic link for ${to}:\n${extractHref(html)}`);
    return;
  }
  const { Resend } = await import('resend');
  const client = new Resend(env.RESEND_API_KEY);
  await client.emails.send({
    from: env.MAGIC_LINK_FROM_EMAIL,
    to: [to],
    subject,
    html,
  });
}

function extractHref(html: string): string {
  const match = html.match(/href="([^"]+)"/);
  return match ? match[1]! : '(no URL)';
}
