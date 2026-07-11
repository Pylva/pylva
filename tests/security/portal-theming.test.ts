// Portal theming attack surface — primary_color + logo_url.
//
// The portal page renders these values inline (`style={{ color: primary_color }}`
// and `<img src={logo_url}>`). The page intentionally does NOT sanitize at the
// render boundary — it trusts the API validator. These tests lock the validator
// rejection contract so the trust assumption stays true.

import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { portalConfigUpdateSchema } from '../../src/lib/portal/validator.js';
import { PORTAL_PRIMARY_COLOR_VALUES } from '@pylva/shared';

function safeParse(input: unknown) {
  return v.safeParse(portalConfigUpdateSchema, input);
}

describe('portal primary_color — CSS-injection surface', () => {
  it('accepts every value in the documented PORTAL_PRIMARY_COLOR_VALUES enum', () => {
    for (const value of PORTAL_PRIMARY_COLOR_VALUES) {
      const result = safeParse({ primary_color: value });
      expect(result.success, `enum value ${value} should pass`).toBe(true);
    }
  });

  it('rejects named CSS colors (not in enum)', () => {
    for (const attempt of ['red', 'rebeccapurple', 'transparent', 'currentColor']) {
      expect(safeParse({ primary_color: attempt }).success).toBe(false);
    }
  });

  it('rejects gradients, var() refs, hsl(), rgb()', () => {
    const attacks = [
      'linear-gradient(red, blue)',
      'var(--evil)',
      'hsl(0, 100%, 50%)',
      'rgb(255 0 0)',
      'rgba(0,0,0,0.5)',
    ];
    for (const attack of attacks) {
      expect(safeParse({ primary_color: attack }).success).toBe(false);
    }
  });

  it('rejects style-context escapes (closing tags, semicolons, expression())', () => {
    const escapes = [
      '#fff;background:url(http://evil)',
      '</style><script>alert(1)</script>',
      '#fff" onload="alert(1)"',
      'red\\;background:black',
      'expression(alert(1))',
      '#fff/*',
    ];
    for (const attack of escapes) {
      expect(safeParse({ primary_color: attack }).success).toBe(false);
    }
  });

  it('rejects empty strings, whitespace, oversized inputs', () => {
    expect(safeParse({ primary_color: '' }).success).toBe(false);
    expect(safeParse({ primary_color: '   ' }).success).toBe(false);
    expect(safeParse({ primary_color: '#'.repeat(10_000) }).success).toBe(false);
  });

  it('accepts null (clear-color signal)', () => {
    expect(safeParse({ primary_color: null }).success).toBe(true);
  });
});

describe('portal logo_url — SSRF / scheme surface', () => {
  it('accepts a normal https URL', () => {
    expect(safeParse({ logo_url: 'https://cdn.example.com/logo.svg' }).success).toBe(true);
  });

  it('accepts null (clear-logo signal)', () => {
    expect(safeParse({ logo_url: null }).success).toBe(true);
  });

  it('rejects javascript:, data:, file:, vbscript: schemes', () => {
    const attacks = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml,<svg onload=alert(1)/>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
    ];
    for (const attack of attacks) {
      expect(safeParse({ logo_url: attack }).success, `${attack} should be rejected`).toBe(false);
    }
  });

  it('rejects http:// (non-TLS)', () => {
    expect(safeParse({ logo_url: 'http://cdn.example.com/logo.svg' }).success).toBe(false);
    expect(safeParse({ logo_url: 'HTTPS://cdn.example.com' }).success).toBe(false); // case-sensitive check
  });

  it('rejects protocol-relative and relative URLs', () => {
    for (const attack of ['//evil.com/logo', '/logo.svg', '../foo', '?foo=bar']) {
      expect(safeParse({ logo_url: attack }).success).toBe(false);
    }
  });

  it('rejects malformed URLs', () => {
    for (const attack of ['', 'not-a-url', 'https://', 'https:/cdn.example.com']) {
      expect(safeParse({ logo_url: attack }).success).toBe(false);
    }
  });
});

describe('portal allowed_iframe_origins — CSP frame-ancestors surface', () => {
  it('accepts bare scheme://host origins', () => {
    const result = safeParse({
      allowed_iframe_origins: ['https://app.example.com', 'https://customer.com'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects origins with paths, queries, or fragments', () => {
    for (const attack of [
      'https://evil.com/path',
      'https://evil.com?x=1',
      'https://evil.com#frag',
    ]) {
      expect(
        safeParse({ allowed_iframe_origins: [attack] }).success,
        `${attack} should be rejected`,
      ).toBe(false);
    }
  });

  it('accepts a bare origin with a single trailing slash', () => {
    // Documented behavior: the validator treats `https://evil.com/` as a
    // bare origin because the pathname is `/`. Anything beyond that fails.
    expect(safeParse({ allowed_iframe_origins: ['https://app.example.com/'] }).success).toBe(true);
  });

  it('caps the list at 10 entries', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `https://host${i}.example.com`);
    expect(safeParse({ allowed_iframe_origins: tooMany }).success).toBe(false);
  });
});

describe('portal company_name — XSS surface', () => {
  it('accepts plain text up to 120 chars', () => {
    expect(safeParse({ company_name: 'Acme Corp.' }).success).toBe(true);
    expect(safeParse({ company_name: 'x'.repeat(120) }).success).toBe(true);
  });

  it('caps length at 120 chars (no megabytes-of-XSS payload)', () => {
    expect(safeParse({ company_name: 'x'.repeat(121) }).success).toBe(false);
  });

  it('accepts angle brackets as plain text — React escapes at render time', () => {
    // The validator does NOT strip HTML — it just bounds length. React handles
    // escaping at render time. Document this contract explicitly.
    expect(safeParse({ company_name: '<script>alert(1)</script>' }).success).toBe(true);
  });
});
