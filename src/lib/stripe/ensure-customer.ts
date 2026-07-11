// SPDX-License-Identifier: Elastic-2.0
// B2b T2 — I-T2-9: ensure a Stripe customer exists on the builder's connected
// account before we create an invoice. First call creates via Connect API +
// persists on `customer_pricing.stripe_customer_id`; subsequent calls return
// the cached id.
//
// Design note: we persist the stripe_customer_id on `customer_pricing` (the
// active version) rather than on `customers` directly because it's bound to
// the builder's Connect account — if a builder reconnects under a different
// Stripe account, the id must reset. POST /api/v1/billing/connect performs
// that reset (it always mints a fresh account). Keeping it on the pricing row
// lets a future migration scope it properly.

import { and, eq, isNull } from 'drizzle-orm';
import { withRLS } from '../db/rls.js';
import { customerPricing, customers } from '../db/schema.js';
import { logger } from '../logger.js';
import { stripeFor } from './client.js';

const log = logger.child({ module: 'stripe.ensure-customer' });

export interface EnsureCustomerResult {
  stripe_customer_id: string;
  /** true if we just created the customer in this call; false if cached. */
  created: boolean;
}

/**
 * Returns the Stripe customer id for (builder, customer) on the given
 * connected account. Creates if missing. Idempotent across concurrent callers
 * as long as the caller is already within an RLS transaction upstream — here
 * we open our own withRLS transaction for the read/update pair.
 */
export async function ensureStripeCustomer(params: {
  builderId: string;
  customerId: string;
  stripeAccountId: string;
  /** Optional metadata attached to the Stripe customer object on creation. */
  metadata?: Record<string, string>;
}): Promise<EnsureCustomerResult> {
  const snapshot = await withRLS(params.builderId, async (tx) => {
    const pricingRows = await tx
      .select({ id: customerPricing.id, stripe_customer_id: customerPricing.stripe_customer_id })
      .from(customerPricing)
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
          isNull(customerPricing.effective_to),
        ),
      )
      .limit(1);
    const customerRows = await tx
      .select({
        external_id: customers.external_id,
        name: customers.name,
        email: customers.email,
      })
      .from(customers)
      .where(and(eq(customers.builder_id, params.builderId), eq(customers.id, params.customerId)))
      .limit(1);
    return {
      pricing: pricingRows[0] ?? null,
      customer: customerRows[0] ?? null,
    };
  });

  if (!snapshot.pricing) {
    // The customer has no active pricing row — caller should configure pricing
    // before generating an invoice. Surface a distinct error so the API layer
    // can map it to a 400 `pricing_not_configured`.
    throw new Error('pricing_not_configured');
  }

  const stripe = stripeFor(params.stripeAccountId);
  const stripeCustomerFields = {
    ...(snapshot.customer?.email ? { email: snapshot.customer.email } : {}),
    ...(snapshot.customer?.name || snapshot.customer?.external_id
      ? { name: snapshot.customer.name ?? snapshot.customer.external_id }
      : {}),
  };

  if (snapshot.pricing.stripe_customer_id) {
    if (Object.keys(stripeCustomerFields).length > 0) {
      await stripe.customers.update(snapshot.pricing.stripe_customer_id, stripeCustomerFields);
    }
    return { stripe_customer_id: snapshot.pricing.stripe_customer_id, created: false };
  }

  const created = await stripe.customers.create({
    ...stripeCustomerFields,
    metadata: {
      pylva_customer_id: params.customerId,
      pylva_builder_id: params.builderId,
      ...(snapshot.customer?.external_id
        ? { pylva_customer_external_id: snapshot.customer.external_id }
        : {}),
      ...(params.metadata ?? {}),
    },
  });

  await withRLS(params.builderId, async (tx) => {
    await tx
      .update(customerPricing)
      .set({ stripe_customer_id: created.id, updated_at: new Date() })
      .where(
        and(
          eq(customerPricing.builder_id, params.builderId),
          eq(customerPricing.customer_id, params.customerId),
          isNull(customerPricing.effective_to),
        ),
      );
  });

  log.info(
    {
      builder_id: params.builderId,
      customer_id: params.customerId,
      stripe_customer_id: created.id,
    },
    'stripe customer created on connected account',
  );

  return { stripe_customer_id: created.id, created: true };
}
