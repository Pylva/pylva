// B2b T2-A — Stripe client factory tests.
//
// Covers I-T2-3 (stripeAccount header on connected-account calls) and I-T2-8
// (STRIPE_API_VERSION pinned). Pure-unit: we mock the `stripe` module so no
// network calls are made.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the env module BEFORE importing the module under test. The client
// factory reads `env.STRIPE_SECRET_KEY` + `env.STRIPE_API_VERSION` at call
// time, so we swap the `env` object in-place.
vi.mock('../../src/lib/config.js', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_fixture_key',
    STRIPE_API_VERSION: '2024-11-20.acacia',
    BILLING_DEFAULT_CURRENCY: 'usd',
  },
}));

// Capture the options Stripe was constructed with so we can assert on them.
// Using a factory-function mock so each call records its args.
const stripeInstances: Array<{ apiKey: string; opts: Record<string, unknown> }> = [];
vi.mock('stripe', () => {
  return {
    default: class StripeMock {
      constructor(apiKey: string, opts: Record<string, unknown>) {
        stripeInstances.push({ apiKey, opts });
      }
    },
  };
});

// Dynamic imports AFTER the mocks are registered.
const { stripeFor, _resetPlatformClient } = await import('../../src/lib/stripe/client.js');

describe('stripeFor() — client factory (I-T2-3, I-T2-8)', () => {
  beforeEach(() => {
    _resetPlatformClient();
    stripeInstances.length = 0;
  });

  afterEach(() => {
    _resetPlatformClient();
    stripeInstances.length = 0;
  });

  it('I-T2-8: constructs with the pinned STRIPE_API_VERSION', () => {
    stripeFor();
    expect(stripeInstances).toHaveLength(1);
    expect(stripeInstances[0]?.opts).toMatchObject({
      apiVersion: '2024-11-20.acacia',
      typescript: true,
    });
  });

  it('I-T2-8: uses the secret key from env', () => {
    stripeFor();
    expect(stripeInstances[0]?.apiKey).toBe('sk_test_fixture_key');
  });

  it('caches the platform client across multiple no-arg calls', () => {
    stripeFor();
    stripeFor();
    stripeFor();
    // Only one Stripe() instance should have been created.
    expect(stripeInstances).toHaveLength(1);
  });

  it('I-T2-3: attaches stripeAccount when called with an accountId', () => {
    stripeFor('acct_connect_test_1');
    expect(stripeInstances).toHaveLength(1);
    expect(stripeInstances[0]?.opts).toMatchObject({
      apiVersion: '2024-11-20.acacia',
      typescript: true,
      stripeAccount: 'acct_connect_test_1',
    });
  });

  it('I-T2-3: creates a fresh instance per accountId call (no cross-account leakage)', () => {
    stripeFor('acct_A');
    stripeFor('acct_B');
    expect(stripeInstances).toHaveLength(2);
    expect(stripeInstances[0]?.opts).toMatchObject({ stripeAccount: 'acct_A' });
    expect(stripeInstances[1]?.opts).toMatchObject({ stripeAccount: 'acct_B' });
  });

  it('platform and connected-account clients coexist independently', () => {
    stripeFor();
    stripeFor('acct_X');
    stripeFor();
    expect(stripeInstances).toHaveLength(2); // platform cached; connected-account created fresh
    expect(stripeInstances[0]?.opts).not.toHaveProperty('stripeAccount');
    expect(stripeInstances[1]?.opts).toMatchObject({ stripeAccount: 'acct_X' });
  });
});

describe('stripeFor() — config validation', () => {
  it('throws when STRIPE_SECRET_KEY is missing', async () => {
    // Swap the mock for this test only.
    vi.resetModules();
    vi.doMock('../../src/lib/config.js', () => ({
      env: {
        STRIPE_SECRET_KEY: undefined,
        STRIPE_API_VERSION: '2024-11-20.acacia',
      },
    }));
    vi.doMock('stripe', () => ({ default: class {} }));
    const { stripeFor: freshFactory, StripeConfigurationError } = await import(
      '../../src/lib/stripe/client.js'
    );
    expect(() => freshFactory()).toThrow(StripeConfigurationError);
    expect(() => freshFactory()).toThrow(/STRIPE_SECRET_KEY/);
    vi.resetModules();
  });

  it('I-T2-8: throws when STRIPE_API_VERSION is missing (pin required)', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/config.js', () => ({
      env: {
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_API_VERSION: undefined,
      },
    }));
    vi.doMock('stripe', () => ({ default: class {} }));
    const { stripeFor: freshFactory, StripeConfigurationError } = await import(
      '../../src/lib/stripe/client.js'
    );
    expect(() => freshFactory()).toThrow(StripeConfigurationError);
    expect(() => freshFactory()).toThrow(/STRIPE_API_VERSION/);
    vi.resetModules();
  });
});
