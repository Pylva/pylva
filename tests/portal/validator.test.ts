// B4-0b — portal config / domain / access-grant validator coverage.

import { describe, it, expect } from 'vitest';
import * as v from 'valibot';
import {
  CostDisplayMode,
  InvoiceDetailLevel,
  PortalPrimaryColor,
  VisibilityLevel,
} from '@pylva/shared';
import {
  portalAccessGrantCreateSchema,
  portalConfigUpdateSchema,
  portalDomainCreateSchema,
} from '../../src/lib/portal/validator.js';

describe('portalConfigUpdateSchema — branding', () => {
  it('accepts a minimal valid patch', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      company_name: 'Acme',
      cost_display_mode: CostDisplayMode.USD,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts all 12 preset palette values for primary_color', () => {
    // Track 4 PR 4.1 (O20): primary_color is now a locked enum, not hex.
    for (const color of Object.values(PortalPrimaryColor)) {
      const parsed = v.safeParse(portalConfigUpdateSchema, { primary_color: color });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects arbitrary hex / named / gradient colors for primary_color', () => {
    for (const bad of [
      '#abc',
      '#aabbcc',
      '#aabbccdd',
      'red',
      'rgb(255,0,0)',
      'linear-gradient(0,0,0)',
      '#xyz',
      '#000000',
    ]) {
      const parsed = v.safeParse(portalConfigUpdateSchema, { primary_color: bad });
      expect(parsed.success).toBe(false);
    }
  });

  it('still accepts hex values for secondary/accent (free-form tints)', () => {
    for (const color of ['#abc', '#aabbcc', '#aabbccdd']) {
      const parsed = v.safeParse(portalConfigUpdateSchema, {
        secondary_color: color,
        accent_color: color,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects http logo URLs (https-only)', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      logo_url: 'http://example.com/logo.png',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects company_name longer than 120 chars', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      company_name: 'a'.repeat(121),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('portalConfigUpdateSchema — visibility / invoice detail', () => {
  it('accepts every visibility_level value', () => {
    for (const level of [
      VisibilityLevel.AGGREGATE_ONLY,
      VisibilityLevel.CATEGORY_MODEL,
      VisibilityLevel.STEP_LEVEL,
    ]) {
      const parsed = v.safeParse(portalConfigUpdateSchema, { visibility_level: level });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects unknown visibility_level', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, { visibility_level: 'detailed' });
    expect(parsed.success).toBe(false);
  });

  it('accepts every invoice_detail_level value', () => {
    for (const level of [
      InvoiceDetailLevel.SUMMARY_ONLY,
      InvoiceDetailLevel.LINE_ITEMS,
      InvoiceDetailLevel.FULL,
    ]) {
      const parsed = v.safeParse(portalConfigUpdateSchema, { invoice_detail_level: level });
      expect(parsed.success).toBe(true);
    }
  });
});

describe('portalConfigUpdateSchema — iframe origins', () => {
  it('accepts a bare scheme://host origin', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      allowed_iframe_origins: ['https://app.acme.com', 'https://staging.acme.com'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects origins with paths', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      allowed_iframe_origins: ['https://app.acme.com/portal'],
    });
    expect(parsed.success).toBe(false);
  });

  it('caps allowed_iframe_origins at 10 entries', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `https://app${i}.acme.com`);
    const parsed = v.safeParse(portalConfigUpdateSchema, { allowed_iframe_origins: eleven });
    expect(parsed.success).toBe(false);
  });
});

describe('portalConfigUpdateSchema — oauth_config', () => {
  it('accepts a Google provider config', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      oauth_config: {
        providers: [
          {
            provider: 'google',
            client_id: 'cid.apps.googleusercontent.com',
            client_secret_encrypted: 'ciphertext-blob',
            enabled: true,
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a generic_oidc config without issuer_url', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      oauth_config: {
        providers: [
          {
            provider: 'generic_oidc',
            client_id: 'cid',
            client_secret_encrypted: 'ciphertext',
            enabled: true,
            // missing issuer_url + endpoints
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects oauth_config with > 10 providers', () => {
    const parsed = v.safeParse(portalConfigUpdateSchema, {
      oauth_config: {
        providers: Array.from({ length: 11 }, () => ({
          provider: 'google' as const,
          client_id: 'cid',
          client_secret_encrypted: 'cipher',
          enabled: false,
        })),
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('portalDomainCreateSchema', () => {
  it('accepts a valid public hostname', () => {
    const parsed = v.safeParse(portalDomainCreateSchema, { domain: 'usage.acme.com' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.domain).toBe('usage.acme.com');
    }
  });

  it('lowercases input', () => {
    const parsed = v.safeParse(portalDomainCreateSchema, { domain: 'Usage.Acme.COM' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.domain).toBe('usage.acme.com');
    }
  });

  it('rejects localhost', () => {
    const parsed = v.safeParse(portalDomainCreateSchema, { domain: 'localhost' });
    expect(parsed.success).toBe(false);
  });

  it('rejects private IPs (10.x, 192.168.x, 172.16-31.x)', () => {
    for (const bad of ['10.0.0.1', '192.168.1.1', '172.20.0.1']) {
      const parsed = v.safeParse(portalDomainCreateSchema, { domain: bad });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects .local / .internal / .test / .invalid TLDs', () => {
    for (const bad of ['x.local', 'x.internal', 'x.test', 'x.invalid']) {
      const parsed = v.safeParse(portalDomainCreateSchema, { domain: bad });
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects bare hostnames without a TLD', () => {
    const parsed = v.safeParse(portalDomainCreateSchema, { domain: 'usage' });
    expect(parsed.success).toBe(false);
  });

  it('rejects hostnames longer than 253 chars', () => {
    const long = 'a.'.repeat(130) + 'com';
    const parsed = v.safeParse(portalDomainCreateSchema, { domain: long });
    expect(parsed.success).toBe(false);
  });
});

describe('portalAccessGrantCreateSchema', () => {
  it('accepts a valid grant', () => {
    const parsed = v.safeParse(portalAccessGrantCreateSchema, {
      customer_id: '00000000-0000-4000-8000-000000000001',
      email: 'enduser@example.com',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.email).toBe('enduser@example.com');
    }
  });

  it('lowercases the email', () => {
    const parsed = v.safeParse(portalAccessGrantCreateSchema, {
      customer_id: '00000000-0000-4000-8000-000000000001',
      email: 'Mixed.Case@Example.COM',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.email).toBe('mixed.case@example.com');
    }
  });

  it('rejects malformed customer_id (not a UUID)', () => {
    const parsed = v.safeParse(portalAccessGrantCreateSchema, {
      customer_id: 'cust_123',
      email: 'a@b.com',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects malformed email', () => {
    const parsed = v.safeParse(portalAccessGrantCreateSchema, {
      customer_id: '00000000-0000-4000-8000-000000000001',
      email: 'not-an-email',
    });
    expect(parsed.success).toBe(false);
  });
});
