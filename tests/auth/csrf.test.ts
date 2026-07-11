// assertSameOrigin CSRF guard. env is mocked so the allowed-origin set is fixed.

import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const { ENV } = vi.hoisted(() => ({
  ENV: {
    PUBLIC_SITE_URL: 'https://app.example.com',
    OAUTH_REDIRECT_BASE_URL: 'https://app.example.com',
    PYLVA_BACKEND_URL: 'https://app.example.com',
  },
}));
vi.mock('@/lib/config', () => ({ env: ENV }));
vi.mock('../../src/lib/config.js', () => ({ env: ENV }));

import { assertSameOrigin } from '@/lib/auth/csrf';

function req(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/v1/invites/send', { method, headers });
}

describe('assertSameOrigin', () => {
  it('allows safe methods regardless of origin', () => {
    expect(assertSameOrigin(req('GET', { origin: 'https://evil.example' }))).toBeNull();
  });

  it('allows a same-origin state-changing request', () => {
    expect(assertSameOrigin(req('POST', { origin: 'https://app.example.com' }))).toBeNull();
  });

  it('rejects a cross-origin state-changing request', () => {
    const res = assertSameOrigin(req('POST', { origin: 'https://evil.example' }));
    expect(res?.status).toBe(403);
  });

  it('rejects when Sec-Fetch-Site says cross-site and no Origin is present', () => {
    const res = assertSameOrigin(req('DELETE', { 'sec-fetch-site': 'cross-site' }));
    expect(res?.status).toBe(403);
  });

  it('allows when Sec-Fetch-Site says same-origin', () => {
    expect(assertSameOrigin(req('POST', { 'sec-fetch-site': 'same-origin' }))).toBeNull();
  });

  it('allows when neither Origin nor Sec-Fetch-Site is present (SameSite backstop)', () => {
    expect(assertSameOrigin(req('POST'))).toBeNull();
  });
});
