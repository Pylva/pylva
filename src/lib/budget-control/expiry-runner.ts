import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { logger } from '../logger.js';
import { expireDueBudgetReservations } from './lifecycle-service.js';

const DEFAULT_BUILDER_CONCURRENCY = 5;
const MAX_BUILDER_CONCURRENCY = 25;
const DEFAULT_BUILDER_PAGE_SIZE = 250;
const MAX_BUILDER_PAGE_SIZE = 1_000;
const DEFAULT_PER_BUILDER_LIMIT = 100;
const MAX_PER_BUILDER_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

let defaultSqlPromise: Promise<Sql> | undefined;

function defaultSql(): Promise<Sql> {
  defaultSqlPromise ??= import('./runtime-posture.js')
    .then(({ getReadyBudgetControlSql }) => getReadyBudgetControlSql())
    .catch((error: unknown) => {
      defaultSqlPromise = undefined;
      throw error;
    });
  return defaultSqlPromise;
}

export interface BudgetReservationExpiryRunResult {
  scanned_builders: number;
  expired_reservations: number;
  errors: number;
}

export interface BudgetReservationExpiryRunnerDependencies {
  listBuilderPage?: (afterBuilderId: string | null, limit: number) => Promise<string[]>;
  expireForBuilder?: (builderId: string, limit: number) => Promise<{ expired: number }>;
  builderConcurrency?: number;
  builderPageSize?: number;
}

export interface BudgetReservationExpiryRunOptions {
  perBuilderLimit?: number;
}

async function listBuilderPage(afterBuilderId: string | null, limit: number): Promise<string[]> {
  // Tenant RLS forbids cross-tenant builders/reservations scans for this
  // non-owner runtime; authoritative reservations additionally stay FORCEd.
  // Migration 052 exposes only the bounded due-reservation tenant identities
  // through a NOBYPASS SECURITY DEFINER owner and a role-specific policy.
  const client = await defaultSql();
  const rows = await client<{ builder_id_text: unknown }[]>`
    SELECT builder_id::TEXT AS builder_id_text
    FROM public.pylva_budget_expiry_actionable_builders(
      ${afterBuilderId}::UUID,
      ${limit}::INTEGER
    )
  `;
  return rows.map((row) => {
    if (typeof row.builder_id_text !== 'string' || !UUID_PATTERN.test(row.builder_id_text)) {
      throw new Error('expiry discovery returned an invalid builder identity');
    }
    return row.builder_id_text;
  });
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function validateBuilderPage(
  builderIds: string[],
  afterBuilderId: string | null,
  pageSize: number,
): string[] {
  if (builderIds.length > pageSize) {
    throw new RangeError('builder page exceeded its requested limit');
  }

  let previous = afterBuilderId;
  for (const builderId of builderIds) {
    if (typeof builderId !== 'string' || builderId.length === 0) {
      throw new TypeError('builder page contained an invalid identity');
    }
    // Production pages are ordered by PostgreSQL UUID comparison. Canonical
    // UUID text has the same order, while this check also prevents a faulty
    // dependency from returning the cursor again and creating an infinite
    // pagination loop.
    if (previous !== null && builderId <= previous) {
      throw new Error('builder page must be strictly ordered after its cursor');
    }
    previous = builderId;
  }
  return builderIds;
}

function validateExpiredCount(value: number, perBuilderLimit: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > perBuilderLimit) {
    throw new RangeError('expiry service returned an invalid expired count');
  }
  return value;
}

function builderLogReference(builderId: string): string {
  // A stable opaque reference is sufficient to correlate repeated failures
  // without copying a tenant UUID into logs.
  return createHash('sha256').update(builderId).digest('hex').slice(0, 12);
}

/**
 * Expire due holds without ever crossing tenant contexts in one transaction.
 * A failed builder is isolated so other tenants keep making progress; the
 * authenticated cron route turns an all-builders-failed run into a 5xx.
 */
export async function runBudgetReservationExpiry(
  options: BudgetReservationExpiryRunOptions = {},
  dependencies: BudgetReservationExpiryRunnerDependencies = {},
): Promise<BudgetReservationExpiryRunResult> {
  const perBuilderLimit = positiveInteger(
    'perBuilderLimit',
    options.perBuilderLimit ?? DEFAULT_PER_BUILDER_LIMIT,
    MAX_PER_BUILDER_LIMIT,
  );
  const builderConcurrency = positiveInteger(
    'builderConcurrency',
    dependencies.builderConcurrency ?? DEFAULT_BUILDER_CONCURRENCY,
    MAX_BUILDER_CONCURRENCY,
  );
  const builderPageSize = positiveInteger(
    'builderPageSize',
    dependencies.builderPageSize ?? DEFAULT_BUILDER_PAGE_SIZE,
    MAX_BUILDER_PAGE_SIZE,
  );
  const loadBuilderPage = dependencies.listBuilderPage ?? listBuilderPage;
  const expireForBuilder = dependencies.expireForBuilder ?? expireDueBudgetReservations;
  const result: BudgetReservationExpiryRunResult = {
    scanned_builders: 0,
    expired_reservations: 0,
    errors: 0,
  };
  const log = logger.child({ module: 'budget-control.expiry-runner' });
  let afterBuilderId: string | null = null;

  for (;;) {
    const builderIds = validateBuilderPage(
      await loadBuilderPage(afterBuilderId, builderPageSize),
      afterBuilderId,
      builderPageSize,
    );
    if (builderIds.length === 0) break;

    for (let offset = 0; offset < builderIds.length; offset += builderConcurrency) {
      const batch = builderIds.slice(offset, offset + builderConcurrency);
      result.scanned_builders += batch.length;
      const settled = await Promise.allSettled(
        batch.map(async (builderId) => {
          const outcome = await expireForBuilder(builderId, perBuilderLimit);
          return validateExpiredCount(outcome.expired, perBuilderLimit);
        }),
      );
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        if (!outcome) continue;
        if (outcome.status === 'fulfilled') {
          result.expired_reservations += outcome.value;
          if (outcome.value === perBuilderLimit) {
            log.warn(
              {
                builder_ref: builderLogReference(batch[index] ?? 'unknown'),
                expired: outcome.value,
                per_builder_limit: perBuilderLimit,
              },
              'budget reservation expiry reached the per-builder batch limit',
            );
          }
          continue;
        }
        result.errors += 1;
        log.error(
          {
            builder_ref: builderLogReference(batch[index] ?? 'unknown'),
            error_type: outcome.reason instanceof Error ? outcome.reason.name : 'UnknownError',
          },
          'budget reservation expiry failed for builder',
        );
      }
    }

    afterBuilderId = builderIds.at(-1) ?? afterBuilderId;
    if (builderIds.length < builderPageSize) break;
  }

  log.info(result, 'budget reservation expiry cycle complete');
  return result;
}

export const __budgetReservationExpiryTesting = {
  defaultBuilderConcurrency: DEFAULT_BUILDER_CONCURRENCY,
  maxBuilderConcurrency: MAX_BUILDER_CONCURRENCY,
  defaultBuilderPageSize: DEFAULT_BUILDER_PAGE_SIZE,
  maxBuilderPageSize: MAX_BUILDER_PAGE_SIZE,
  defaultPerBuilderLimit: DEFAULT_PER_BUILDER_LIMIT,
  maxPerBuilderLimit: MAX_PER_BUILDER_LIMIT,
  validateBuilderPage,
  validateExpiredCount,
  builderLogReference,
};
