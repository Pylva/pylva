import { authorizeBuilderCapability } from '../auth/builder-entitlement.js';
import type { DrizzleTransaction } from '../db/rls.js';
import {
  isProductAccessMutationDeniedError,
  withProductAccessMutation,
} from '../auth/product-access-mutation.js';

/**
 * A channel delivery can spend tens of seconds loading configuration or
 * waiting between retries. The workspace may be suspended during that time,
 * so the authorization performed by the caller is not sufficient at the
 * actual outbound side-effect boundary.
 */
export class AlertDeliveryAccessDeniedError extends Error {
  readonly code = 'alert_delivery_access_denied';

  constructor(readonly builderId: string) {
    super('Alert delivery denied because the workspace has no product access');
    this.name = 'AlertDeliveryAccessDeniedError';
  }
}

export class AlertDeliveryEntitlementLookupError extends Error {
  readonly code = 'alert_delivery_entitlement_lookup_failed';

  constructor(readonly builderId: string) {
    super('Alert delivery entitlement lookup failed');
    this.name = 'AlertDeliveryEntitlementLookupError';
  }
}

export function isAlertDeliveryAccessDeniedError(
  error: unknown,
): error is AlertDeliveryAccessDeniedError {
  return (
    error instanceof AlertDeliveryAccessDeniedError ||
    (error instanceof Error &&
      (error as Error & { code?: unknown }).code === 'alert_delivery_access_denied')
  );
}

/**
 * Fail closed using authoritative PostgreSQL state. This is an early,
 * read-only gate only; every external attempt and durable alert mutation must
 * use `withAlertDeliveryAccessMutation` at its actual side-effect boundary.
 */
export async function requireAlertDeliveryAccess(builderId: string): Promise<void> {
  const decision = await authorizeBuilderCapability(builderId, 'product');
  if (!decision.allowed) {
    if (decision.lookup?.kind === 'lookup_failed') {
      throw new AlertDeliveryEntitlementLookupError(builderId);
    }
    throw new AlertDeliveryAccessDeniedError(builderId);
  }
}

/**
 * Linearize one durable alert mutation or one outbound delivery attempt with
 * checkout/suspension transitions. A lifecycle update either commits first
 * (and this side effect is denied) or waits until the already-authorized side
 * effect finishes.
 *
 * Keep configuration loading and retry backoff outside this callback so a
 * slow delivery never holds the lifecycle lock between attempts.
 */
export async function withAlertDeliveryAccessMutation<T>(
  builderId: string,
  mutation: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withProductAccessMutation(builderId, mutation);
  } catch (error) {
    if (isProductAccessMutationDeniedError(error)) {
      throw new AlertDeliveryAccessDeniedError(builderId);
    }
    throw error;
  }
}
