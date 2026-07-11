// SPDX-License-Identifier: Elastic-2.0
// B2b T2-D — POST /api/v1/billing/webhooks
//
// Inbound Stripe webhooks. No JWT / API key auth — Stripe's signature IS
// the auth. I-T2-4: we read the raw body via `request.text()` BEFORE any
// `.json()` call; constructEvent requires byte-for-byte identical bytes.
//
// Builder resolution: we don't know the builder until we see event.account
// (the `acct_...` from Stripe Connect) and look up stripe_connect. The
// lookup bypasses RLS (we don't have the builder_id yet); once resolved,
// every downstream write goes through `withRLS(builderId)`.
//
// Replay idempotency: the public handler records event ids in
// stripe_connect_event_log. Completed duplicates are acked without
// re-dispatch; in-progress duplicates return non-2xx so Stripe retries.
//
// Public route: add to src/middleware.ts bypass list; Stripe cannot carry
// a JWT.

import { type NextRequest } from 'next/server.js';
import { handleConnectStripeWebhook } from '@/lib/stripe/connect-webhook-public-handler';
import { toNextResponse } from '@/lib/public-http/response';

export async function POST(request: NextRequest): Promise<Response> {
  // I-T2-4: raw body MUST be read via .text(); never .json() first.
  return toNextResponse(
    await handleConnectStripeWebhook({
      rawBody: await request.text(),
      signature: request.headers.get('stripe-signature'),
    }),
  );
}
