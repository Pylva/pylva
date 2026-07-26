// SPDX-License-Identifier: Elastic-2.0
import type Stripe from 'stripe';
import { BuilderAccessState } from '@pylva/shared';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withRLS, type DrizzleTransaction } from '../db/rls.js';
import { getBuilderEntitlementForShare } from '../db/advisory-locks.js';
import { stripeConnect, stripeConnectEventLog } from '../db/schema.js';
import { env } from '../config.js';
import { logger } from '../logger.js';
import {
  dispatch,
  type ConnectWebhookAlertEffect,
} from './webhook-handlers.js';
import { deliverBuilderAlert } from '../alerts/builder-alert.js';
import { stripeFor } from './client.js';
import { emptyResponse, textResponse, type PublicHttpResponse } from '../public-http/response.js';

const log = logger.child({ module: 'billing.webhooks' });
const CONNECT_WEBHOOK_IN_PROGRESS_MS = 5 * 60 * 1000;
const CONNECT_WEBHOOK_RETRY_AFTER_SECONDS = 30;

class ConnectWebhookEntitlementUnavailableError extends Error {
  constructor(message = 'connect webhook entitlement is unavailable') {
    super(message);
    this.name = 'ConnectWebhookEntitlementUnavailableError';
  }
}

async function resolveBuilderId(stripeAccountId: string): Promise<string | null> {
  const rows = await db
    .select({ builder_id: stripeConnect.builder_id })
    .from(stripeConnect)
    .where(eq(stripeConnect.stripe_account_id, stripeAccountId))
    .limit(1);
  return rows[0]?.builder_id ?? null;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function isRecentProcessing(startedAt: Date | string | null | undefined, now: Date): boolean {
  const started = asDate(startedAt);
  return Boolean(started && now.getTime() - started.getTime() < CONNECT_WEBHOOK_IN_PROGRESS_MS);
}

async function claimConnectEvent(params: {
  stripeAccountId: string;
  stripeEventId: string;
  type: string;
  builderId: string;
  transaction: DrizzleTransaction;
}): Promise<PublicHttpResponse | null> {
  const now = new Date();
  const inserted = await params.transaction
    .insert(stripeConnectEventLog)
    .values({
      stripe_account_id: params.stripeAccountId,
      stripe_event_id: params.stripeEventId,
      type: params.type,
      builder_id: params.builderId,
      received_at: now,
      processing_started_at: now,
      last_error: null,
    })
    .onConflictDoNothing()
    .returning({ stripe_event_id: stripeConnectEventLog.stripe_event_id });

  if (inserted.length > 0) return null;

  const existing = await params.transaction
    .select({
      handled_at: stripeConnectEventLog.handled_at,
      processing_started_at: stripeConnectEventLog.processing_started_at,
    })
    .from(stripeConnectEventLog)
    .where(
      and(
        eq(stripeConnectEventLog.stripe_account_id, params.stripeAccountId),
        eq(stripeConnectEventLog.stripe_event_id, params.stripeEventId),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (row?.handled_at != null) {
    log.info(
      { account: params.stripeAccountId, event_id: params.stripeEventId, type: params.type },
      'connect webhook duplicate already handled - ack',
    );
    return emptyResponse(200);
  }

  if (isRecentProcessing(row?.processing_started_at, now)) {
    log.info(
      { account: params.stripeAccountId, event_id: params.stripeEventId, type: params.type },
      'connect webhook duplicate still processing - retry',
    );
    return textResponse('event already processing', 503, {
      'Retry-After': String(CONNECT_WEBHOOK_RETRY_AFTER_SECONDS),
    });
  }

  const staleBefore = new Date(now.getTime() - CONNECT_WEBHOOK_IN_PROGRESS_MS);
  const reclaimed = await params.transaction
    .update(stripeConnectEventLog)
    .set({
      type: params.type,
      builder_id: params.builderId,
      processing_started_at: now,
      last_error: null,
    })
    .where(
      and(
        eq(stripeConnectEventLog.stripe_account_id, params.stripeAccountId),
        eq(stripeConnectEventLog.stripe_event_id, params.stripeEventId),
        isNull(stripeConnectEventLog.handled_at),
        or(
          isNull(stripeConnectEventLog.processing_started_at),
          lt(stripeConnectEventLog.processing_started_at, staleBefore),
        ),
      ),
    )
    .returning({ stripe_event_id: stripeConnectEventLog.stripe_event_id });

  if (reclaimed.length > 0) return null;

  log.info(
    { account: params.stripeAccountId, event_id: params.stripeEventId, type: params.type },
    'connect webhook duplicate claim lost - retry',
  );
  return textResponse('event already processing', 503, {
    'Retry-After': String(CONNECT_WEBHOOK_RETRY_AFTER_SECONDS),
  });
}

async function markConnectEventHandled(params: {
  stripeAccountId: string;
  stripeEventId: string;
  builderId: string;
  transaction: DrizzleTransaction;
}): Promise<void> {
  const updated = await params.transaction
    .update(stripeConnectEventLog)
    .set({
      builder_id: params.builderId,
      handled_at: new Date(),
      processing_started_at: null,
      last_error: null,
    })
    .where(
      and(
        eq(stripeConnectEventLog.stripe_account_id, params.stripeAccountId),
        eq(stripeConnectEventLog.stripe_event_id, params.stripeEventId),
        isNull(stripeConnectEventLog.handled_at),
      ),
    )
    .returning({ stripe_event_id: stripeConnectEventLog.stripe_event_id });

  if (updated.length === 0) {
    throw new Error(
      `Connect event ${params.stripeAccountId}/${params.stripeEventId} lost its transactional claim`,
    );
  }
}

export async function handleConnectStripeWebhook(params: {
  rawBody: string;
  signature: string | null;
}): Promise<PublicHttpResponse> {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_API_VERSION || !env.STRIPE_SECRET_KEY) {
    log.error({}, 'stripe webhook envs not configured');
    return textResponse('webhook not configured', 500);
  }

  if (!params.signature) {
    return textResponse('missing stripe-signature header', 400);
  }

  const stripe = stripeFor();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      params.rawBody,
      params.signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'invalid webhook signature');
    return textResponse('invalid signature', 400);
  }

  if (!event.account) {
    log.info(
      { event_id: event.id, type: event.type },
      'event has no account - ignored (platform webhook)',
    );
    return emptyResponse(200);
  }

  let builderId: string | null;
  try {
    builderId = await resolveBuilderId(event.account);
  } catch (error) {
    log.error(
      {
        account: event.account,
        event_id: event.id,
        type: event.type,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      },
      'connect webhook builder lookup failed - retry',
    );
    return textResponse('builder lookup unavailable', 503, {
      'Retry-After': String(CONNECT_WEBHOOK_RETRY_AFTER_SECONDS),
    });
  }
  if (!builderId) {
    log.info(
      { account: event.account, event_id: event.id },
      'no builder for Stripe account; ignoring',
    );
    return emptyResponse(200);
  }

  let alertEffect: ConnectWebhookAlertEffect | null;
  try {
    const transactionResult = await withRLS(
      builderId,
      async (transaction) => {
        const claimResponse = await claimConnectEvent({
          stripeAccountId: event.account!,
          stripeEventId: event.id,
          type: event.type,
          builderId,
          transaction,
        });
        if (claimResponse) {
          return { response: claimResponse, alertEffect: null };
        }

        let resolution: Awaited<
          ReturnType<typeof getBuilderEntitlementForShare>
        >;
        try {
          resolution = await getBuilderEntitlementForShare(
            transaction,
            builderId,
          );
        } catch (error) {
          throw new ConnectWebhookEntitlementUnavailableError(
            error instanceof Error ? error.name : undefined,
          );
        }
        if (resolution === null || !resolution.ok) {
          throw new ConnectWebhookEntitlementUnavailableError();
        }
        const entitlement = resolution.entitlement;
        if (
          entitlement.access_state === BuilderAccessState.CHECKOUT_REQUIRED ||
          entitlement.access_state === BuilderAccessState.SUSPENDED
        ) {
          await markConnectEventHandled({
            stripeAccountId: event.account!,
            stripeEventId: event.id,
            builderId,
            transaction,
          });
          return { response: null, alertEffect: null };
        }
        if (!entitlement.has_product_access) {
          throw new ConnectWebhookEntitlementUnavailableError();
        }

        const effect = await dispatch(
          event,
          {
            builderId,
            eventId: event.id,
            eventCreated: event.created,
          },
          transaction,
        );
        await markConnectEventHandled({
          stripeAccountId: event.account!,
          stripeEventId: event.id,
          builderId,
          transaction,
        });
        return { response: null, alertEffect: effect };
      },
    );
    if (transactionResult.response) return transactionResult.response;
    alertEffect = transactionResult.alertEffect;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ConnectWebhookEntitlementUnavailableError) {
      log.error(
        {
          builder_id: builderId,
          event_id: event.id,
          type: event.type,
          error_type: err.name,
        },
        'connect webhook entitlement fence failed before atomic commit - retry',
      );
      return textResponse('workspace entitlement unavailable', 503, {
        'Retry-After': String(CONNECT_WEBHOOK_RETRY_AFTER_SECONDS),
      });
    }
    log.error(
      { builder_id: builderId, event_id: event.id, type: event.type, error: message },
      'handler threw',
    );
    return textResponse('handler error', 500);
  }

  if (alertEffect) {
    try {
      await deliverBuilderAlert({
        builderId: alertEffect.builderId,
        payload: alertEffect.payload,
      });
    } catch (error) {
      log.error(
        {
          builder_id: alertEffect.builderId,
          event_id: event.id,
          type: event.type,
          error_type: error instanceof Error ? error.name : 'UnknownError',
        },
        'post-commit Connect alert delivery threw; event remains terminal',
      );
    }
  }

  return emptyResponse(200);
}
