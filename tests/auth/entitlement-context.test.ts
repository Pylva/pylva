import { describe, expect, it } from 'vitest';
import {
  InvalidBuilderEntitlementError,
  normalizeEntitlementContext,
  requireEntitlementContext,
} from '../../src/lib/auth/entitlement-context.js';

describe('auth entitlement context normalization', () => {
  it('maps only the exact rolling-expand legacy Free tuple to checkout-required', () => {
    expect(
      normalizeEntitlementContext({
        plan: 'free',
        access_state: null,
        entitlement_source: null,
      }),
    ).toEqual({
      plan: null,
      accessState: 'checkout_required',
      entitlementSource: null,
    });
  });

  it.each([
    { plan: 'free', access_state: 'active', entitlement_source: 'admin' },
    { plan: 'pro', access_state: null, entitlement_source: null },
    { plan: 'pro', access_state: 'suspended', entitlement_source: 'stripe' },
    { plan: null, access_state: 'active', entitlement_source: null },
  ])('fails closed for malformed tuple $plan/$access_state/$entitlement_source', (tuple) => {
    expect(normalizeEntitlementContext(tuple)).toBeNull();
    expect(() => requireEntitlementContext(tuple)).toThrow(InvalidBuilderEntitlementError);
  });
});
