import { sql as drizzleSql } from 'drizzle-orm';
import { env } from '../config.js';
import { unwrapRows } from '../db/query-utils.js';
import type { DrizzleTransaction } from '../db/rls.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'auth.hosted-provisional-signup' });

export const HOSTED_PROVISIONAL_SIGNUP_CONTROL_KEY = 'provisional_signup';

export type HostedProvisionalSignupDisabledReason =
  | 'control_missing_or_disabled'
  | 'control_lookup_failed';

/**
 * Fail-closed signal used only during the hosted remove-Free cutover.
 *
 * This error is deliberately distinct from an entitlement failure: no personal
 * workspace has been created yet. Authentication callers may retry after the
 * protected rollout process enables the durable database control.
 */
export class HostedProvisionalSignupDisabledError extends Error {
  constructor(
    public readonly reason: HostedProvisionalSignupDisabledReason,
    options?: { cause?: unknown },
  ) {
    super('Hosted provisional signup is temporarily unavailable', options);
    this.name = 'HostedProvisionalSignupDisabledError';
  }
}

interface HostedProvisionalSignupControlRow extends Record<string, unknown> {
  enabled: boolean;
}

/**
 * Assert that the protected rollout has enabled new hosted provisional
 * workspaces. Missing table/row, a disabled row, malformed data, and database
 * errors all deny creation.
 *
 * Existing memberships, email-adopted workspaces, and valid invite-first joins
 * are resolved before this function is called. Self-hosted creation never reads
 * the hosted-only control.
 */
export async function assertHostedProvisionalSignupEnabledTx(
  tx: DrizzleTransaction,
): Promise<void> {
  if (env.PYLVA_DEPLOYMENT_MODE !== 'hosted') return;

  let rows: HostedProvisionalSignupControlRow[];
  try {
    const result = await tx.execute<HostedProvisionalSignupControlRow>(drizzleSql`
      SELECT enabled
      FROM public.hosted_provisional_signup_rollout
      WHERE control_key = ${HOSTED_PROVISIONAL_SIGNUP_CONTROL_KEY}
    `);
    rows = unwrapRows<HostedProvisionalSignupControlRow>(result);
  } catch (cause) {
    log.error(
      { reason: 'control_lookup_failed' },
      'hosted provisional signup denied because rollout control lookup failed',
    );
    throw new HostedProvisionalSignupDisabledError('control_lookup_failed', {
      cause,
    });
  }

  if (rows.length !== 1 || rows[0]?.enabled !== true) {
    log.warn(
      {
        reason: 'control_missing_or_disabled',
        observed_rows: rows.length,
      },
      'hosted provisional signup denied until protected rollout enablement',
    );
    throw new HostedProvisionalSignupDisabledError(
      'control_missing_or_disabled',
    );
  }
}
