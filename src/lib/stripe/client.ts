// SPDX-License-Identifier: Elastic-2.0
// B2b T2 — pinned Stripe SDK client factory.
//
// I-T2-3: every Stripe API call on a builder's Connect account MUST include
// `stripeAccount` in the request options. The `stripeFor(accountId)` overload
// does this by wrapping the returned client's requestOptions so callers cannot
// forget.
//
// I-T2-8: STRIPE_API_VERSION is pinned via env (e.g. "2024-11-20.acacia"). The
// factory refuses to construct without it — a missing version would let Stripe
// silently upgrade us on the next default-version bump.
//
// Tests mock the `stripe` module; in unit runs the factory doesn't actually
// open a network connection.
//
// Cost guardrail: single Stripe() instance per invocation is fine — the SDK
// reuses the HTTP agent across calls within the same process.

import Stripe from 'stripe';
import { env } from '../config.js';
import { StripeConfigurationError } from './config-error.js';

let platformClient: Stripe | null = null;

function requireConfig(): { apiKey: string; apiVersion: Stripe.LatestApiVersion } {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeConfigurationError('STRIPE_SECRET_KEY');
  }
  if (!env.STRIPE_API_VERSION) {
    throw new StripeConfigurationError('STRIPE_API_VERSION');
  }
  return {
    apiKey: env.STRIPE_SECRET_KEY,
    apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
  };
}

/**
 * Returns a Stripe SDK instance. Without args, returns a platform-level client
 * (for creating Connect accounts). With an accountId, returns a client that
 * auto-attaches `stripeAccount` to every call on the connected account.
 *
 * The `Stripe-Account` header is the mechanism Stripe uses to scope calls to
 * a connected account — forgetting it would silently hit the platform account.
 */
export function stripeFor(accountId?: string): Stripe {
  const { apiKey, apiVersion } = requireConfig();

  if (!accountId) {
    if (!platformClient) {
      platformClient = new Stripe(apiKey, {
        apiVersion,
        typescript: true,
      });
    }
    return platformClient;
  }

  return new Stripe(apiKey, {
    apiVersion,
    typescript: true,
    stripeAccount: accountId,
  });
}

/** Test helper — reset the cached platform client. Never call from runtime code. */
export function _resetPlatformClient(): void {
  platformClient = null;
}

export { StripeConfigurationError } from './config-error.js';
