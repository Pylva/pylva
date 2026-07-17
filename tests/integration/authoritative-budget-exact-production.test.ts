import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetUnavailableReason,
  ReserveUsageRequestSchema,
  type ParsedReserveUsageRequest,
  type ReserveUsageResponse,
} from '@pylva/shared';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installBudgetExactBackfillAdapter } from '../../src/lib/budget-control/exact-backfill-adapter.js';
import {
  createBudgetControlCutover,
  markBudgetControlReady,
} from '../../src/lib/budget-control/readiness.js';
import { createReserveBudgetUsage } from '../../src/lib/budget-control/reservation-service.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATION_FILENAME = '051_authoritative_budget_control_runtime.sql';
type LedgerSql = Sql | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;

let scratch: ScratchDb | undefined;
let pool: Sql | undefined;

function db(): Sql {
  if (!pool) throw new Error('exact production scratch pool is not ready');
  return pool;
}

async function useBuilder(sql: LedgerSql, builderId: string): Promise<void> {
  await sql`SELECT pg_catalog.set_config('app.builder_id', ${builderId}, true)`;
}

async function withBuilder<T>(
  builderId: string,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await db().begin(async (tx) => {
    await useBuilder(tx, builderId);
    return callback(tx);
  })) as T;
}

async function createBuilder(): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const rows = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`exact-production-${suffix}@example.com`}, 'Exact production', 'pro',
      ${`exact-production-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  const builderId = rows[0]?.id;
  if (!builderId) throw new Error('builder insert returned no identity');
  return builderId;
}

async function insertPerCustomerRule(builderId: string): Promise<string> {
  return withBuilder(builderId, async (tx) => {
    const ruleKey = crypto.randomUUID();
    const snapshot: JsonObject = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'per_customer',
      target_customer_id: null,
      period: 'month',
      enforcement: 'hard_stop',
      limit_usd: '100',
    };
    await tx`
      INSERT INTO public.budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${crypto.randomUUID()}::UUID, ${ruleKey}::UUID, 0,
        'per_customer', NULL, 'month', 'hard_stop', 100,
        ${tx.json(snapshot)}::JSONB,
        public.pylva_budget_jsonb_sha256(${tx.json(snapshot)}::JSONB)
      )
    `;
    return ruleKey;
  });
}

function request(customerId: string): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: crypto.randomUUID(),
    customer_id: customerId,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'exact.production',
    kind: 'llm',
    provider: 'openai',
    model: 'gpt-4o-mini',
    estimated_input_tokens: 10,
    max_output_tokens: 10,
  });
}

function reserved(requestValue: ParsedReserveUsageRequest): ReserveUsageResponse {
  return {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: 'reserved',
    allowed: true,
    decision_id: crypto.randomUUID(),
    operation_id: requestValue.operation_id,
    reservation_id: crypto.randomUUID(),
    state: 'reserved',
    reserved_usd: '0.01',
    remaining_usd: '99.99',
    expires_at: '2030-01-01T00:05:00.000Z',
    warnings: [],
  };
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'budget_exact_production' });
  try {
    await applyMigrationsThrough(scratch, MIGRATION_FILENAME);
    pool = postgres(scratch.url, { max: 8, onnotice: () => undefined });
    await db().unsafe(`
      CREATE TABLE public.test_budget_exact_openings (
        builder_id UUID NOT NULL REFERENCES public.builders(id) ON DELETE RESTRICT,
        rule_key UUID NOT NULL,
        subject_customer_id TEXT NOT NULL,
        opening_usd NUMERIC(38,18) NOT NULL,
        measured_through TIMESTAMPTZ,
        activated BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (builder_id, rule_key, subject_customer_id)
      );
      ALTER TABLE public.test_budget_exact_openings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.test_budget_exact_openings FORCE ROW LEVEL SECURITY;
      CREATE POLICY test_budget_exact_openings_isolation
        ON public.test_budget_exact_openings
        FOR ALL
        USING (builder_id = current_setting('app.builder_id', true)::UUID)
        WITH CHECK (builder_id = current_setting('app.builder_id', true)::UUID);
    `);

    installBudgetExactBackfillAdapter({
      async activate({ transaction, builderId, cutoverAt }) {
        const rows = await transaction<{ subject_customer_id: string }[]>`
          UPDATE public.test_budget_exact_openings
          SET measured_through = ${cutoverAt}::TIMESTAMPTZ, activated = TRUE
          WHERE builder_id = ${builderId}::UUID
          RETURNING subject_customer_id
        `;
        if (rows.length === 0) throw new Error('durable exact manifest is empty');
      },
      async resolveOpening(input) {
        if (input.subjectCustomerId === null) {
          throw new Error('pooled exact opening was not provisioned');
        }
        const rows = await input.tx<{ opening: string }[]>`
          SELECT public.pylva_budget_decimal_text(opening_usd) AS opening
          FROM public.test_budget_exact_openings
          WHERE builder_id = ${input.builderId}::UUID
            AND rule_key = ${input.ruleKey}::UUID
            AND subject_customer_id = ${input.subjectCustomerId}
            AND activated
            AND measured_through = ${input.measuredThrough}::TIMESTAMPTZ
        `;
        const opening = rows[0]?.opening;
        if (!opening) throw new Error('durable exact customer opening is absent');
        return opening;
      },
    });
  } catch (error) {
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
});

afterAll(async () => {
  try {
    await pool?.end();
  } finally {
    await scratch?.drop();
  }
});

describe('production exact-backfill adapter path', () => {
  it('activates, materializes future customers through reserve, and never fabricates absent zero', async () => {
    const builderId = await createBuilder();
    const ruleKey = await insertPerCustomerRule(builderId);
    await withBuilder(builderId, async (tx) => {
      await tx`
        INSERT INTO public.test_budget_exact_openings (
          builder_id, rule_key, subject_customer_id, opening_usd
        )
        VALUES
          (${builderId}::UUID, ${ruleKey}::UUID, 'customer_a', 1.25),
          (${builderId}::UUID, ${ruleKey}::UUID, 'customer_b', 8.5)
      `;
    });

    await createBudgetControlCutover(builderId, 'exact_backfill', {
      client: db(),
      maxAttempts: 1,
    });
    await expect(
      markBudgetControlReady(builderId, { client: db(), maxAttempts: 1 }),
    ).resolves.toMatchObject({ ready: true, mode: 'exact_backfill' });

    const authorizeAttempt = vi.fn(async ({ request: requestValue }) => reserved(requestValue));
    const persistControlFailure = vi.fn(
      async ({ request: requestValue }): Promise<ReserveUsageResponse> => ({
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        decision: 'unavailable',
        allowed: false,
        decision_id: crypto.randomUUID(),
        operation_id: requestValue.operation_id,
        reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
        retryable: false,
      }),
    );
    const reserve = createReserveBudgetUsage({
      client: db(),
      controlEnabled: () => true,
      authorizeAttempt,
      persistControlFailure,
      maxAttempts: 1,
    });

    await expect(reserve(builderId, request('customer_a'))).resolves.toMatchObject({
      decision: 'reserved',
    });
    await expect(reserve(builderId, request('customer_b'))).resolves.toMatchObject({
      decision: 'reserved',
    });
    await expect(reserve(builderId, request('customer_absent'))).resolves.toMatchObject({
      decision: 'unavailable',
      allowed: false,
    });
    expect(authorizeAttempt).toHaveBeenCalledTimes(2);
    expect(persistControlFailure).toHaveBeenCalledTimes(1);

    const accounts = await withBuilder(
      builderId,
      (tx) =>
        tx<{ customer_id: string; opening: string; source: string }[]>`
        SELECT account.subject_customer_id AS customer_id,
               public.pylva_budget_decimal_text(account.opening_committed_usd) AS opening,
               evidence.source
        FROM public.budget_accounts account
        JOIN public.budget_account_opening_evidence evidence
          ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
        WHERE account.builder_id = ${builderId}::UUID
        ORDER BY account.subject_customer_id
      `,
    );
    expect(accounts).toEqual([
      { customer_id: 'customer_a', opening: '1.25', source: 'exact_backfill' },
      { customer_id: 'customer_b', opening: '8.5', source: 'exact_backfill' },
    ]);
  });
});
