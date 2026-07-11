import { describe, expect, it } from 'vitest';
import {
  authHrefWithNext,
  buildPostAuthRedirectUrl,
  decodeOAuthStateNext,
  encodeOAuthStateValue,
  isDashboardAuthNext,
  nextPathOrgSlug,
  validateAuthNext,
} from '@/lib/auth/post-auth-redirect';

describe('post-auth redirect helpers', () => {
  it('accepts same-origin /o/{slug}/dashboard subtree paths', () => {
    for (const value of [
      '/o/x/dashboard',
      '/o/my-org2/dashboard',
      '/o/acme/dashboard/settings/members',
      '/o/a/dashboard/rules/123e4567-e89b-12d3-a456-426614174000',
      `/o/x/dashboard/${'a'.repeat(185)}`, // exactly 200 chars
    ]) {
      expect(validateAuthNext(value), `${value} should be accepted`).toBe(value);
    }
  });

  it('rejects open-redirect vectors and non-dashboard next paths', () => {
    for (const value of [
      null,
      undefined,
      '',
      'https://evil.com',
      '//evil.com',
      '/\\evil.com',
      '/login',
      '/subscribe/pro',
      'o/x/dashboard',
      '/o/x/dashboard/../../../etc',
      '/o/UPPER/dashboard',
      '/o/x/Dashboard',
      '/o/x/dashboards',
      '/o/-leading/dashboard',
      '/o/slug/dashboard?query=1',
      '/o/slug/dashboard#fragment',
      '/o/x/dashboard//nested',
      `/o/x/dashboard/${'a'.repeat(186)}`, // 201 chars — over the cap
    ]) {
      expect(validateAuthNext(value), `${String(value)} should be rejected`).toBeNull();
    }
  });

  it('extracts the org slug from a validated next path', () => {
    const next = validateAuthNext('/o/my-org2/dashboard/rules');
    if (!next || !isDashboardAuthNext(next)) {
      throw new Error('expected a validated dashboard next path');
    }
    expect(nextPathOrgSlug(next)).toBe('my-org2');
  });

  it('round-trips OAuth state next only for the v1 encoded shape', () => {
    const encoded = encodeOAuthStateValue('nonce-1', '/o/acme/dashboard/rules');
    expect(encoded.startsWith('v1.')).toBe(true);
    expect(decodeOAuthStateNext(encoded)).toBe('/o/acme/dashboard/rules');

    expect(encodeOAuthStateValue('nonce-2', null)).toBe('nonce-2');
    expect(encodeOAuthStateValue('nonce-3', 'https://evil.com')).toBe('nonce-3');
    expect(encodeOAuthStateValue('nonce-4', '/login')).toBe('nonce-4');
    expect(decodeOAuthStateNext('nonce-2')).toBeNull();
    expect(decodeOAuthStateNext('v1.not-valid-base64url')).toBeNull();
    expect(decodeOAuthStateNext('legacy-plain-nonce')).toBeNull();
  });

  it('re-validates the embedded next when decoding a v1 state', () => {
    const forged = `v1.${Buffer.from(
      JSON.stringify({ nonce: 'nonce-1', next: 'https://evil.com' }),
      'utf8',
    ).toString('base64url')}`;
    expect(decodeOAuthStateNext(forged)).toBeNull();
  });

  it('honors next only when its slug matches the session org', () => {
    const params = { baseUrl: 'https://app.pylva.test', orgSlug: 'acme' };

    expect(buildPostAuthRedirectUrl({ ...params, next: '/o/acme/dashboard/rules' })).toBe(
      'https://app.pylva.test/o/acme/dashboard/rules',
    );
    expect(buildPostAuthRedirectUrl({ ...params, next: '/o/other/dashboard' })).toBe(
      'https://app.pylva.test/o/acme/dashboard',
    );
    expect(buildPostAuthRedirectUrl({ ...params, next: null })).toBe(
      'https://app.pylva.test/o/acme/dashboard',
    );
    expect(buildPostAuthRedirectUrl({ ...params, next: 'https://evil.com' })).toBe(
      'https://app.pylva.test/o/acme/dashboard',
    );
    expect(buildPostAuthRedirectUrl({ ...params, next: '//evil.com' })).toBe(
      'https://app.pylva.test/o/acme/dashboard',
    );
  });

  it('appends next to auth hrefs only when the path is valid', () => {
    expect(authHrefWithNext('/login', '/o/acme/dashboard/rules')).toBe(
      '/login?next=%2Fo%2Facme%2Fdashboard%2Frules',
    );
    expect(authHrefWithNext('/api/auth/github?provider=github', '/o/acme/dashboard')).toBe(
      '/api/auth/github?provider=github&next=%2Fo%2Facme%2Fdashboard',
    );
    expect(authHrefWithNext('/login', 'https://evil.com')).toBe('/login');
    expect(authHrefWithNext('/login', '/subscribe/pro')).toBe('/login');
    expect(authHrefWithNext('/login', null)).toBe('/login');
  });
});
