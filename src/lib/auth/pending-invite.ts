import type { NextRequest, NextResponse } from 'next/server.js';
import { env } from '../config.js';

export const PENDING_INVITE_COOKIE = 'pylva_pending_invite';
export const INVITE_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function validInviteToken(value: string | null | undefined): string | null {
  return value && INVITE_TOKEN_PATTERN.test(value) ? value : null;
}

export function readPendingInviteToken(request: NextRequest): string | null {
  return validInviteToken(request.cookies.get(PENDING_INVITE_COOKIE)?.value);
}

export function setPendingInviteCookie(response: NextResponse, token: string): void {
  response.cookies.set(PENDING_INVITE_COOKIE, token, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(env.MAGIC_LINK_TTL_SECONDS, 10 * 60),
  });
}

export function clearPendingInviteCookie(response: NextResponse): void {
  response.cookies.set(PENDING_INVITE_COOKIE, '', {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE && env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
