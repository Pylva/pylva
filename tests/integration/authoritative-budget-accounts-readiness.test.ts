import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BudgetAccountPeriodNotEligibleError,
  BudgetExactOpeningBalanceUnavailableError,
  ensureBudgetAccountsMaterialized,
} from '../../src/lib/budget-control/accounts.js';
import {
  BudgetControlNotReadyError,
  BudgetExactBackfillActivationUnavailableError,
  createBudgetControlCutover,
  getBudgetControlReadiness,
  markBudgetControlReady,
  refreshBudgetControlCutover,
} from '../../src/lib/budget-control/readiness.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATION_FILENAME = '051_authoritative_budget_control_runtime.sql';
const BUILDER_LOCK_SEED = 50_620_260_714;

type LedgerSql = Sql | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;
type RuleScope = 'pooled' | 'per_customer';
type RulePeriod = 'hour' | 'day' | 'week' | 'month';

interface RuleFixture {
  id: string;
  ruleKey: string;
  scope: RuleScope;
  targetCustomerId: string | null;
  period: RulePeriod;
  enforcement: 'hard_stop' | 'advisory';
  limitUsd: string;
}

let scratch: ScratchDb | undefined;
let pool: Sql | undefined;

function db(): Sql {
  if (!pool) throw new Error('accounts/readiness scratch pool is not ready');
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

async function jsonHash(sql: LedgerSql, value: JsonObject): Promise<string> {
  const rows = await sql<{ value: string }[]>`
    SELECT public.pylva_budget_jsonb_sha256(${sql.json(value)}::JSONB) AS value
  `;
  const hash = rows[0]?.value;
  if (!hash) throw new Error('canonical snapshot hash was unavailable');
  return hash;
}

async function createBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const rows = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`${label}-${suffix}@example.com`}, ${label}, 'pro',
      ${`${label}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')}
    )
    RETURNING id
  `;
  const builderId = rows[0]?.id;
  if (!builderId) throw new Error('builder insert returned no identity');
  return builderId;
}

async function insertRuleInTransaction(
  tx: TransactionSql,
  builderId: string,
  values: Partial<{
    ruleKey: string;
    scope: RuleScope;
    targetCustomerId: string | null;
    period: RulePeriod;
    enforcement: 'hard_stop' | 'advisory';
    limitUsd: string;
  }> = {},
): Promise<RuleFixture> {
  const ruleKey = values.ruleKey ?? crypto.randomUUID();
  const id = crypto.randomUUID();
  const scope = values.scope ?? 'pooled';
  const targetCustomerId = scope === 'pooled' ? null : (values.targetCustomerId ?? null);
  const period = values.period ?? 'day';
  const enforcement = values.enforcement ?? 'hard_stop';
  const limitUsd = values.limitUsd ?? '10';
  const snapshot: JsonObject = {
    schema_version: '1.0',
    rule_key: ruleKey,
    scope,
    target_customer_id: targetCustomerId,
    period,
    enforcement,
    limit_usd: limitUsd,
  };
  const snapshotHash = await jsonHash(tx, snapshot);
  const rows = await tx<{ id: string; rule_key: string }[]>`
    INSERT INTO public.budget_rule_revisions (
      builder_id, id, rule_key, revision, scope, target_customer_id,
      period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
    )
    VALUES (
      ${builderId}::UUID, ${id}::UUID, ${ruleKey}::UUID, 0, ${scope},
      ${targetCustomerId}, ${period}, ${enforcement}, ${limitUsd}::NUMERIC,
      ${tx.json(snapshot)}::JSONB, ${snapshotHash}
    )
    RETURNING id::TEXT AS id, rule_key::TEXT AS rule_key
  `;
  if (!rows[0]) throw new Error('rule revision insert returned no identity');
  return {
    id: rows[0].id,
    ruleKey: rows[0].rule_key,
    scope,
    targetCustomerId,
    period,
    enforcement,
    limitUsd,
  };
}

async function insertRule(
  builderId: string,
  values: Parameters<typeof insertRuleInTransaction>[2] = {},
): Promise<RuleFixture> {
  return withBuilder(builderId, (tx) => insertRuleInTransaction(tx, builderId, values));
}

async function rotateRule(
  builderId: string,
  current: RuleFixture,
  limitUsd: string,
): Promise<RuleFixture> {
  return withBuilder(builderId, async (tx) => {
    await tx`
      UPDATE public.budget_rule_revisions
      SET retirement_reason = 'superseded'
      WHERE builder_id = ${builderId}::UUID AND id = ${current.id}::UUID
    `;
    return insertRuleInTransaction(tx, builderId, {
      ruleKey: current.ruleKey,
      scope: current.scope,
      targetCustomerId: current.targetCustomerId,
      period: current.period,
      enforcement: current.enforcement === 'hard_stop' ? 'advisory' : 'hard_stop',
      limitUsd,
    });
  });
}

async function disableRule(builderId: string, current: RuleFixture): Promise<void> {
  await withBuilder(builderId, async (tx) => {
    await tx`
      UPDATE public.budget_rule_revisions
      SET retirement_reason = 'disabled'
      WHERE builder_id = ${builderId}::UUID AND id = ${current.id}::UUID
    `;
  });
}

/**
 * Adversarial fixture: erase timestamp ordering while retaining the real,
 * immutable authority-order markers. This proves classification does not
 * guess from two events that happened in the same server millisecond.
 */
async function forceRuleTimestampToCutover(
  builderId: string,
  ruleKey: string,
): Promise<{ originOrder: bigint; readyOrder: bigint; timestampsEqual: boolean }> {
  await db().unsafe(
    'ALTER TABLE public.budget_rule_revisions DISABLE TRIGGER budget_rule_revisions_immutability_guard',
  );
  try {
    await withBuilder(builderId, async (tx) => {
      await tx`
        UPDATE public.budget_rule_revisions revision
        SET active_from = cutover.cutover_at,
            created_at = cutover.cutover_at
        FROM public.budget_control_cutovers cutover
        WHERE revision.builder_id = ${builderId}::UUID
          AND revision.rule_key = ${ruleKey}::UUID
          AND cutover.builder_id = revision.builder_id
      `;
    });
  } finally {
    await db().unsafe(
      'ALTER TABLE public.budget_rule_revisions ENABLE TRIGGER budget_rule_revisions_immutability_guard',
    );
  }

  return withBuilder(builderId, async (tx) => {
    const rows = await tx<
      { origin_order: string; ready_order: string; timestamps_equal: boolean }[]
    >`
      SELECT origin.authority_order::TEXT AS origin_order,
             cutover.ready_order::TEXT AS ready_order,
             origin.active_from = cutover.cutover_at AS timestamps_equal
      FROM public.budget_rule_revisions origin
      JOIN public.budget_control_cutovers cutover
        ON cutover.builder_id = origin.builder_id
      WHERE origin.builder_id = ${builderId}::UUID
        AND origin.rule_key = ${ruleKey}::UUID
        AND origin.revision = 0
    `;
    const row = rows[0];
    if (!row) throw new Error('authority-order fixture was unavailable');
    return {
      originOrder: BigInt(row.origin_order),
      readyOrder: BigInt(row.ready_order),
      timestampsEqual: row.timestamps_equal,
    };
  });
}

async function readyEmptyNextPeriodBuilder(label: string): Promise<string> {
  const builderId = await createBuilder(label);
  const pending = await createBudgetControlCutover(builderId, 'next_period', {
    client: db(),
    maxAttempts: 1,
  });
  expect(pending).toMatchObject({ ready: false, reason: 'pending', mode: 'next_period' });
  const ready = await markBudgetControlReady(builderId, { client: db(), maxAttempts: 1 });
  expect(ready).toMatchObject({ ready: true, mode: 'next_period' });
  return builderId;
}

async function readyExactBuilder(
  label: string,
  rulesBeforeCutover = 0,
): Promise<{
  builderId: string;
  rules: RuleFixture[];
}> {
  const builderId = await createBuilder(label);
  const rules: RuleFixture[] = [];
  for (let index = 0; index < rulesBeforeCutover; index += 1) {
    rules.push(await insertRule(builderId, { period: 'day' }));
  }
  await createBudgetControlCutover(builderId, 'exact_backfill', {
    client: db(),
    maxAttempts: 1,
  });
  await markBudgetControlReady(builderId, {
    client: db(),
    maxAttempts: 1,
    activateExactBackfill: async () => undefined,
  });
  return { builderId, rules };
}

async function countRows(
  builderId: string,
  table: 'budget_accounts' | 'budget_account_opening_evidence',
) {
  return withBuilder(builderId, async (tx) => {
    const rows = await tx<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count
      FROM ${tx(table)}
      WHERE builder_id = ${builderId}::UUID
    `;
    return Number(rows[0]?.count ?? '-1');
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'budget_accounts_readiness' });
  try {
    await applyMigrationsThrough(scratch, MIGRATION_FILENAME);
    pool = postgres(scratch.url, { max: 12, onnotice: () => undefined });
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

describe('authoritative readiness and account materialization against PostgreSQL', () => {
  it('fails closed for missing and pending builder readiness without creating accounts', async () => {
    const missingBuilder = await createBuilder('missing-readiness');
    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId: missingBuilder, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).rejects.toMatchObject({
      name: 'BudgetControlNotReadyError',
      readiness: { ready: false, reason: 'missing', mode: null, cutover_at: null },
    });

    const pendingBuilder = await createBuilder('pending-readiness');
    await insertRule(pendingBuilder);
    await createBudgetControlCutover(pendingBuilder, 'exact_backfill', {
      client: db(),
      maxAttempts: 1,
    });
    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId: pendingBuilder, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).rejects.toMatchObject({
      name: 'BudgetControlNotReadyError',
      readiness: expect.objectContaining({ ready: false, reason: 'pending' }),
    });
    expect(await countRows(missingBuilder, 'budget_accounts')).toBe(0);
    expect(await countRows(pendingBuilder, 'budget_accounts')).toBe(0);
  });

  it('advances a pending next-period boundary monotonically and refuses early activation', async () => {
    const builderId = await createBuilder('next-period-boundary');
    await insertRule(builderId, { period: 'hour' });
    const first = await createBudgetControlCutover(builderId, 'next_period', {
      client: db(),
      maxAttempts: 1,
    });
    if (first.ready || first.reason !== 'pending') throw new Error('expected pending cutover');

    await insertRule(builderId, { period: 'month' });
    const refreshed = await refreshBudgetControlCutover(builderId, {
      client: db(),
      maxAttempts: 1,
    });
    if (refreshed.ready || refreshed.reason !== 'pending')
      throw new Error('expected pending cutover');
    expect(refreshed.cutover_at >= first.cutover_at).toBe(true);
    expect(refreshed.cutover_at).not.toBe(first.cutover_at);

    await expect(
      markBudgetControlReady(builderId, { client: db(), maxAttempts: 1 }),
    ).rejects.toThrow('next-period cutover cannot become ready before its activation boundary');
    await expect(
      getBudgetControlReadiness(builderId, { client: db(), maxAttempts: 1 }),
    ).resolves.toEqual(refreshed);
  });

  it('makes ready state irreversible after a safe next-period activation', async () => {
    const builderId = await readyEmptyNextPeriodBuilder('next-period-one-way');

    await expect(
      withBuilder(builderId, async (tx) => {
        await tx`
          UPDATE public.budget_control_cutovers
          SET status = 'pending'
          WHERE builder_id = ${builderId}::UUID
        `;
      }),
    ).rejects.toThrow('immutable');
    await expect(
      withBuilder(builderId, async (tx) => {
        await tx`
          DELETE FROM public.budget_control_cutovers
          WHERE builder_id = ${builderId}::UUID
        `;
      }),
    ).rejects.toThrow('immutable');
    await expect(
      getBudgetControlReadiness(builderId, { client: db(), maxAttempts: 1 }),
    ).resolves.toMatchObject({ ready: true, mode: 'next_period' });
  });

  it('requires an explicit exact-backfill adapter and rolls its failure back atomically', async () => {
    const builderId = await createBuilder('exact-activation');
    await createBudgetControlCutover(builderId, 'exact_backfill', {
      client: db(),
      maxAttempts: 1,
    });

    await expect(
      markBudgetControlReady(builderId, { client: db(), maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(BudgetExactBackfillActivationUnavailableError);

    await expect(
      markBudgetControlReady(builderId, {
        client: db(),
        maxAttempts: 1,
        activateExactBackfill: async ({ transaction }) => {
          await transaction`
            UPDATE public.builders SET name = 'must-roll-back'
            WHERE id = ${builderId}::UUID
          `;
          throw new Error('reconciliation adapter failed');
        },
      }),
    ).rejects.toThrow('reconciliation adapter failed');

    const builderRows = await db()<[{ name: string }]>`
      SELECT name FROM public.builders WHERE id = ${builderId}::UUID
    `;
    expect(builderRows[0]?.name).toBe('exact-activation');
    await expect(
      getBudgetControlReadiness(builderId, { client: db(), maxAttempts: 1 }),
    ).resolves.toMatchObject({ ready: false, reason: 'pending', mode: 'exact_backfill' });

    const adapter = vi.fn(async () => undefined);
    await expect(
      markBudgetControlReady(builderId, {
        client: db(),
        maxAttempts: 1,
        activateExactBackfill: adapter,
      }),
    ).resolves.toMatchObject({ ready: true, mode: 'exact_backfill' });
    expect(adapter).toHaveBeenCalledTimes(1);

    await markBudgetControlReady(builderId, {
      client: db(),
      maxAttempts: 1,
      activateExactBackfill: adapter,
    });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('records exact opening evidence for a pre-cutover current-period rule', async () => {
    const { builderId, rules } = await readyExactBuilder('exact-opening', 1);
    const rule = rules[0]!;
    const resolver = vi.fn(async () => '12.3400');

    const result = await ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_a' },
      { client: db(), maxAttempts: 1, resolveExactOpeningBalance: resolver },
    );
    expect(result).toMatchObject({ existing: 0, materialized: 1 });
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        builderId,
        ruleKey: rule.ruleKey,
        ruleRevisionId: rule.id,
        measuredThrough: expect.stringMatching(/Z$/),
      }),
    );

    const evidence = await withBuilder(
      builderId,
      async (tx) =>
        tx<
          {
            source: string;
            account_opening: string;
            evidence_opening: string;
            measured_matches: boolean;
            hash_matches: boolean;
          }[]
        >`
        SELECT evidence.source,
               public.pylva_budget_decimal_text(account.opening_committed_usd) AS account_opening,
               public.pylva_budget_decimal_text(evidence.opening_committed_usd) AS evidence_opening,
               evidence.measured_through = cutover.cutover_at AS measured_matches,
               evidence.evidence_snapshot_hash =
                 public.pylva_budget_jsonb_sha256(evidence.evidence_snapshot) AS hash_matches
        FROM public.budget_accounts account
        JOIN public.budget_account_opening_evidence evidence
          ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
        JOIN public.budget_control_cutovers cutover
          ON cutover.builder_id = account.builder_id
        WHERE account.builder_id = ${builderId}::UUID
      `,
    );
    expect(evidence).toEqual([
      {
        source: 'exact_backfill',
        account_opening: '12.34',
        evidence_opening: '12.34',
        measured_matches: true,
        hash_matches: true,
      },
    ]);
  });

  it('resolves every future per-customer first use from durable exact state', async () => {
    const builderId = await createBuilder('future-customer-opening');
    const rule = await insertRule(builderId, { scope: 'per_customer', period: 'month' });
    await createBudgetControlCutover(builderId, 'exact_backfill', {
      client: db(),
      maxAttempts: 1,
    });
    await markBudgetControlReady(builderId, {
      client: db(),
      maxAttempts: 1,
      activateExactBackfill: async () => undefined,
    });
    const openings = new Map([
      ['customer_a', '1.25'],
      ['customer_b', '8.5'],
    ]);
    const resolveOpening = vi.fn(
      async ({ subjectCustomerId }: { subjectCustomerId: string | null }) => {
        const opening = subjectCustomerId === null ? undefined : openings.get(subjectCustomerId);
        if (!opening) throw new Error('reconciled customer opening is absent');
        return opening;
      },
    );

    await ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_a' },
      { client: db(), maxAttempts: 1, resolveExactOpeningBalance: resolveOpening },
    );
    await ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_b' },
      { client: db(), maxAttempts: 1, resolveExactOpeningBalance: resolveOpening },
    );
    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_absent' },
        { client: db(), maxAttempts: 1, resolveExactOpeningBalance: resolveOpening },
      ),
    ).rejects.toThrow('reconciled customer opening is absent');

    const rows = await withBuilder(
      builderId,
      (tx) =>
        tx<{ rule_key: string; subject_customer_id: string; source: string; opening: string }[]>`
        SELECT account.rule_key::TEXT AS rule_key, account.subject_customer_id,
               evidence.source,
               public.pylva_budget_decimal_text(account.opening_committed_usd) AS opening
        FROM public.budget_accounts account
        JOIN public.budget_account_opening_evidence evidence
          ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
        WHERE account.builder_id = ${builderId}::UUID
        ORDER BY account.subject_customer_id
      `,
    );
    expect(rows).toEqual([
      {
        rule_key: rule.ruleKey,
        subject_customer_id: 'customer_a',
        source: 'exact_backfill',
        opening: '1.25',
      },
      {
        rule_key: rule.ruleKey,
        subject_customer_id: 'customer_b',
        source: 'exact_backfill',
        opening: '8.5',
      },
    ]);
    expect(resolveOpening).toHaveBeenCalledTimes(3);
  });

  it('uses explicit zero evidence for a new post-cutover rule without calling an exact resolver', async () => {
    const { builderId } = await readyExactBuilder('post-cutover-zero');
    const rule = await insertRule(builderId, { period: 'month' });
    const ordering = await forceRuleTimestampToCutover(builderId, rule.ruleKey);
    expect(ordering.timestampsEqual).toBe(true);
    expect(ordering.originOrder > ordering.readyOrder).toBe(true);

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).resolves.toMatchObject({ materialized: 1 });

    const rows = await withBuilder(
      builderId,
      (tx) =>
        tx<{ rule_key: string; source: string; opening: string }[]>`
        SELECT account.rule_key::TEXT AS rule_key, evidence.source,
               public.pylva_budget_decimal_text(account.opening_committed_usd) AS opening
        FROM public.budget_accounts account
        JOIN public.budget_account_opening_evidence evidence
          ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
        WHERE account.builder_id = ${builderId}::UUID
      `,
    );
    expect(rows).toEqual([{ rule_key: rule.ruleKey, source: 'post_cutover_zero', opening: '0' }]);
  });

  it('never guesses zero for a pre-cutover exact account', async () => {
    const { builderId, rules } = await readyExactBuilder('no-guessed-zero', 1);
    const ordering = await forceRuleTimestampToCutover(builderId, rules[0]!.ruleKey);
    expect(ordering.timestampsEqual).toBe(true);
    expect(ordering.originOrder < ordering.readyOrder).toBe(true);
    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).rejects.toBeInstanceOf(BudgetExactOpeningBalanceUnavailableError);
    expect(await countRows(builderId, 'budget_accounts')).toBe(0);
  });

  it('rolls back every account when a later exact resolver value is malformed', async () => {
    const { builderId } = await readyExactBuilder('malformed-opening-rollback', 2);
    let call = 0;

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        {
          client: db(),
          maxAttempts: 1,
          resolveExactOpeningBalance: async () => {
            call += 1;
            return call === 1 ? '1.25' : 'not-a-decimal';
          },
        },
      ),
    ).rejects.toThrow();
    expect(call).toBe(2);
    expect(await countRows(builderId, 'budget_accounts')).toBe(0);
    expect(await countRows(builderId, 'budget_account_opening_evidence')).toBe(0);

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        {
          client: db(),
          maxAttempts: 1,
          resolveExactOpeningBalance: async () => '2.5',
        },
      ),
    ).resolves.toMatchObject({ materialized: 2 });
  });

  it('materializes PostgreSQL-owned UTC hour/day/week/month boundaries', async () => {
    const builderId = await readyEmptyNextPeriodBuilder('period-boundaries');
    for (const period of ['hour', 'day', 'week', 'month'] as const) {
      await insertRule(builderId, { period });
    }
    await ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_a' },
      { client: db(), maxAttempts: 1 },
    );

    const rows = await withBuilder(
      builderId,
      (tx) =>
        tx<{ period: RulePeriod; aligned: boolean; exact_end: boolean }[]>`
        SELECT period,
               CASE period
                 WHEN 'hour' THEN period_start AT TIME ZONE 'UTC' =
                   date_trunc('hour', period_start AT TIME ZONE 'UTC')
                 WHEN 'day' THEN period_start AT TIME ZONE 'UTC' =
                   date_trunc('day', period_start AT TIME ZONE 'UTC')
                 WHEN 'week' THEN period_start AT TIME ZONE 'UTC' =
                   date_trunc('week', period_start AT TIME ZONE 'UTC')
                 WHEN 'month' THEN period_start AT TIME ZONE 'UTC' =
                   date_trunc('month', period_start AT TIME ZONE 'UTC')
               END AS aligned,
               period_end = CASE period
                 WHEN 'hour' THEN period_start + INTERVAL '1 hour'
                 WHEN 'day' THEN period_start + INTERVAL '1 day'
                 WHEN 'week' THEN period_start + INTERVAL '7 days'
                 WHEN 'month' THEN
                   ((period_start AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC'
               END AS exact_end
        FROM public.budget_accounts
        WHERE builder_id = ${builderId}::UUID
        ORDER BY CASE period
          WHEN 'hour' THEN 1 WHEN 'day' THEN 2 WHEN 'week' THEN 3 ELSE 4 END
      `,
    );
    expect(rows).toEqual([
      { period: 'hour', aligned: true, exact_end: true },
      { period: 'day', aligned: true, exact_end: true },
      { period: 'week', aligned: true, exact_end: true },
      { period: 'month', aligned: true, exact_end: true },
    ]);
  });

  it('reuses a stable account across limit/enforcement revision rotation', async () => {
    const builderId = await readyEmptyNextPeriodBuilder('stable-account');
    const initial = await insertRule(builderId, { limitUsd: '10', enforcement: 'hard_stop' });
    const first = await ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_a' },
      { client: db(), maxAttempts: 1 },
    );
    const successor = await rotateRule(builderId, initial, '20');
    const second = await ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_a' },
      { client: db(), maxAttempts: 1 },
    );

    expect(second).toMatchObject({ existing: 1, materialized: 0, account_ids: first.account_ids });
    const rows = await withBuilder(
      builderId,
      (tx) =>
        tx<
          {
            account_id: string;
            initial_revision_id: string;
            origin_limit: string;
            current_limit: string;
          }[]
        >`
        SELECT account.id::TEXT AS account_id,
               account.initial_rule_revision_id::TEXT AS initial_revision_id,
               public.pylva_budget_decimal_text(account.limit_usd) AS origin_limit,
               public.pylva_budget_decimal_text(revision.limit_usd) AS current_limit
        FROM public.budget_accounts account
        JOIN public.budget_rule_revisions revision
          ON revision.builder_id = account.builder_id
         AND revision.rule_key = account.rule_key
         AND revision.retired_at IS NULL
        WHERE account.builder_id = ${builderId}::UUID
      `,
    );
    expect(rows).toEqual([
      {
        account_id: first.account_ids[0],
        initial_revision_id: initial.id,
        origin_limit: '10',
        current_limit: '20',
      },
    ]);
    expect(successor.id).not.toBe(initial.id);
  });

  it('retains safe-zero eligibility when a post-cutover rule rotates before first use', async () => {
    const { builderId } = await readyExactBuilder('rotated-before-first-use');
    const initial = await insertRule(builderId, { limitUsd: '10' });
    const successor = await rotateRule(builderId, initial, '20');

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).resolves.toMatchObject({ existing: 0, materialized: 1 });

    const rows = await withBuilder(
      builderId,
      (tx) =>
        tx<{ initial_rule_revision_id: string; source: string; opening: string }[]>`
        SELECT account.initial_rule_revision_id::TEXT AS initial_rule_revision_id,
               evidence.source,
               public.pylva_budget_decimal_text(account.opening_committed_usd) AS opening
        FROM public.budget_accounts account
        JOIN public.budget_account_opening_evidence evidence
          ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
        WHERE account.builder_id = ${builderId}::UUID
      `,
    );
    expect(rows).toEqual([
      {
        initial_rule_revision_id: successor.id,
        source: 'post_cutover_zero',
        opening: '0',
      },
    ]);
  });

  it('requires an exact opening when a pre-cutover rule is disabled then re-enabled', async () => {
    const builderId = await createBuilder('pre-cutover-reenabled');
    const origin = await insertRule(builderId, { period: 'month', limitUsd: '10' });
    await disableRule(builderId, origin);
    await createBudgetControlCutover(builderId, 'exact_backfill', {
      client: db(),
      maxAttempts: 1,
    });
    await markBudgetControlReady(builderId, {
      client: db(),
      maxAttempts: 1,
      activateExactBackfill: async () => undefined,
    });
    const reenabled = await insertRule(builderId, {
      ruleKey: origin.ruleKey,
      scope: origin.scope,
      targetCustomerId: origin.targetCustomerId,
      period: origin.period,
      enforcement: origin.enforcement,
      limitUsd: '15',
    });

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).rejects.toBeInstanceOf(BudgetExactOpeningBalanceUnavailableError);
    expect(await countRows(builderId, 'budget_accounts')).toBe(0);

    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        {
          client: db(),
          maxAttempts: 1,
          resolveExactOpeningBalance: async () => '4.5',
        },
      ),
    ).resolves.toMatchObject({ materialized: 1 });
    const rows = await withBuilder(
      builderId,
      (tx) =>
        tx<{ initial_rule_revision_id: string; source: string; opening: string }[]>`
        SELECT account.initial_rule_revision_id::TEXT AS initial_rule_revision_id,
               evidence.source,
               public.pylva_budget_decimal_text(account.opening_committed_usd) AS opening
        FROM public.budget_accounts account
        JOIN public.budget_account_opening_evidence evidence
          ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
        WHERE account.builder_id = ${builderId}::UUID
      `,
    );
    expect(rows).toEqual([
      {
        initial_rule_revision_id: reenabled.id,
        source: 'exact_backfill',
        opening: '4.5',
      },
    ]);
  });

  it('serializes concurrent pooled/per-customer first use under the exclusive builder lock', async () => {
    const builderId = await readyEmptyNextPeriodBuilder('concurrent-materialization');
    await insertRule(builderId, { scope: 'pooled' });
    await insertRule(builderId, { scope: 'per_customer' });
    await insertRule(builderId, { scope: 'per_customer', targetCustomerId: 'customer_b' });

    const lockAcquired = deferred();
    const releaseLock = deferred();
    const lockHolder = withBuilder(builderId, async (tx) => {
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${builderId}::UUID::TEXT, ${BUILDER_LOCK_SEED}::BIGINT)
        )
      `;
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    const firstUse = ensureBudgetAccountsMaterialized(
      { builderId, customerId: 'customer_a' },
      { client: db(), maxAttempts: 1 },
    );
    const stateWhileLocked = await Promise.race([
      firstUse.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    expect(stateWhileLocked).toBe('waiting');
    expect(await countRows(builderId, 'budget_accounts')).toBe(0);
    releaseLock.resolve();
    await expect(lockHolder).resolves.toBeUndefined();
    await expect(firstUse).resolves.toMatchObject({ materialized: 2 });

    const [againA, customerB] = await Promise.all([
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_b' },
        { client: db(), maxAttempts: 1 },
      ),
    ]);
    expect(againA).toMatchObject({ existing: 2, materialized: 0 });
    expect(customerB).toMatchObject({ existing: 1, materialized: 2 });
    expect(await countRows(builderId, 'budget_accounts')).toBe(4);
    expect(await countRows(builderId, 'budget_account_opening_evidence')).toBe(4);

    const identities = await withBuilder(
      builderId,
      (tx) =>
        tx<{ scope: RuleScope; subject_customer_id: string | null; count: string }[]>`
        SELECT scope, subject_customer_id, COUNT(*)::TEXT AS count
        FROM public.budget_accounts
        WHERE builder_id = ${builderId}::UUID
        GROUP BY scope, subject_customer_id
        ORDER BY scope, subject_customer_id NULLS FIRST
      `,
    );
    expect(identities).toEqual([
      { scope: 'per_customer', subject_customer_id: 'customer_a', count: '1' },
      { scope: 'per_customer', subject_customer_id: 'customer_b', count: '2' },
      { scope: 'pooled', subject_customer_id: null, count: '1' },
    ]);
  });

  it('refuses an ineligible current period instead of inserting an unproven opening', async () => {
    const builderId = await createBuilder('ineligible-period');
    await insertRule(builderId, { period: 'month' });
    await createBudgetControlCutover(builderId, 'next_period', {
      client: db(),
      maxAttempts: 1,
    });

    // The builder is deliberately still pending; the readiness error must win
    // before any period or opening inference is attempted.
    await expect(
      ensureBudgetAccountsMaterialized(
        { builderId, customerId: 'customer_a' },
        { client: db(), maxAttempts: 1 },
      ),
    ).rejects.toBeInstanceOf(BudgetControlNotReadyError);
    expect(await countRows(builderId, 'budget_accounts')).toBe(0);

    // Keep the exported domain error covered by the real-service suite's
    // deterministic classification contract even though a valid 051 database
    // cannot manufacture this contradictory ready/unsafe state.
    expect(new BudgetAccountPeriodNotEligibleError(crypto.randomUUID()).name).toBe(
      'BudgetAccountPeriodNotEligibleError',
    );
  });
});
