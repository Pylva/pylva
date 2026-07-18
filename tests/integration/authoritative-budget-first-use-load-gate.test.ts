import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBudgetAccountsMaterialized } from '../../src/lib/budget-control/accounts.js';
import {
  createBudgetControlCutover,
  markBudgetControlReady,
} from '../../src/lib/budget-control/readiness.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATION_FILENAME = '051_authoritative_budget_control_runtime.sql';
const BUILDER_LOCK_SEED = 50_620_260_714;
const RULE_COUNT = 16;
const CUSTOMER_COUNT = 16;
const CONTENTION_ROUNDS = 3;
const FORCED_LOCK_HOLD_MS = 150;

// These are intentionally generous relative to an ordinary local/CI run. The
// gate should detect a material regression or unbounded lock convoy without
// failing because one shared runner had a brief scheduling pause.
const LOCK_WAIT_INCLUSIVE_P95_BUDGET_MS = 5_000;
const LOCK_WAIT_INCLUSIVE_MAX_BUDGET_MS = 7_500;
const ROUND_TOTAL_BUDGET_MS = 10_000;

type LedgerSql = Sql | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;

interface TimedMaterialization {
  customerId: string;
  existing: number;
  latencyMs: number;
  materialized: number;
}

let scratch: ScratchDb | undefined;
let pool: Sql | undefined;

function db(): Sql {
  if (!pool) throw new Error('first-use load-gate scratch pool is not ready');
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
  if (!hash) throw new Error('canonical load-gate snapshot hash was unavailable');
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
  if (!builderId) throw new Error('load-gate builder insert returned no identity');
  return builderId;
}

async function createReadyEmptyBuilder(label: string): Promise<string> {
  const builderId = await createBuilder(label);
  await createBudgetControlCutover(builderId, 'next_period', {
    client: db(),
    maxAttempts: 1,
  });
  const readiness = await markBudgetControlReady(builderId, {
    client: db(),
    maxAttempts: 1,
  });
  if (!readiness.ready) throw new Error('load-gate builder did not become ready');
  return builderId;
}

async function insertHourlyPerCustomerRules(builderId: string, count: number): Promise<string[]> {
  return withBuilder(builderId, async (tx) => {
    const ruleKeys: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = crypto.randomUUID();
      const ruleKey = crypto.randomUUID();
      const snapshot: JsonObject = {
        schema_version: '1.0',
        rule_key: ruleKey,
        scope: 'per_customer',
        target_customer_id: null,
        period: 'hour',
        enforcement: 'hard_stop',
        limit_usd: '100',
      };
      const snapshotHash = await jsonHash(tx, snapshot);
      await tx`
        INSERT INTO public.budget_rule_revisions (
          builder_id, id, rule_key, revision, scope, target_customer_id,
          period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
        )
        VALUES (
          ${builderId}::UUID, ${id}::UUID, ${ruleKey}::UUID, 0,
          'per_customer', NULL, 'hour', 'hard_stop', 100,
          ${tx.json(snapshot)}::JSONB, ${snapshotHash}
        )
      `;
      ruleKeys.push(ruleKey);
    }
    return ruleKeys;
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) throw new Error('cannot calculate a percentile without observations');
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index]!;
}

async function materializeTimed(
  builderId: string,
  customerId: string,
): Promise<TimedMaterialization> {
  const startedAt = performance.now();
  const result = await ensureBudgetAccountsMaterialized(
    { builderId, customerId },
    { client: db(), maxAttempts: 1 },
  );
  return {
    customerId,
    existing: result.existing,
    latencyMs: performance.now() - startedAt,
    materialized: result.materialized,
  };
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'budget_first_use_load_gate' });
  try {
    await applyMigrationsThrough(scratch, MIGRATION_FILENAME);
    // One connection holds the deliberate blocker while all 16 customer calls
    // reach PostgreSQL concurrently. This remains below ordinary PG defaults.
    pool = postgres(scratch.url, { max: CUSTOMER_COUNT + 4, onnotice: () => undefined });
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

describe('authoritative high-cardinality first-use rollout gate', () => {
  it('materializes 256 hourly per-customer accounts with bounded lock-wait-inclusive latency', async () => {
    const roundMetrics: Array<{
      forced_lock_hold_ms: number;
      max_ms: number;
      p50_ms: number;
      p95_ms: number;
      replay_total_ms: number;
      round: number;
      total_ms: number;
    }> = [];

    for (let round = 0; round < CONTENTION_ROUNDS; round += 1) {
      const builderId = await createReadyEmptyBuilder(`first-use-load-${round}`);
      await insertHourlyPerCustomerRules(builderId, RULE_COUNT);
      const customerIds = Array.from(
        { length: CUSTOMER_COUNT },
        (_, index) => `load_customer_${round}_${index.toString().padStart(2, '0')}`,
      );

      const lockAcquired = deferred();
      const releaseLock = deferred();
      const lockHolder = withBuilder(builderId, async (tx) => {
        await tx`
            SELECT pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended(
                ${builderId}::UUID::TEXT,
                ${BUILDER_LOCK_SEED}::BIGINT
              )
            )
          `;
        lockAcquired.resolve();
        await releaseLock.promise;
      });
      await lockAcquired.promise;

      let settledWhileBlocked = 0;
      const roundStartedAt = performance.now();
      const pending = customerIds.map((customerId) =>
        materializeTimed(builderId, customerId).then(
          (value) => {
            settledWhileBlocked += 1;
            return { ok: true as const, value };
          },
          (error: unknown) => {
            settledWhileBlocked += 1;
            return { error, ok: false as const };
          },
        ),
      );

      await delay(FORCED_LOCK_HOLD_MS);
      const forcedLockHoldMs = performance.now() - roundStartedAt;
      expect(settledWhileBlocked).toBe(0);
      releaseLock.resolve();
      await lockHolder;

      const outcomes = await Promise.all(pending);
      const completedAt = performance.now();
      const results: TimedMaterialization[] = [];
      for (const outcome of outcomes) {
        if (!outcome.ok) throw outcome.error;
        results.push(outcome.value);
      }
      expect(results).toHaveLength(CUSTOMER_COUNT);
      expect(
        results.every((result) => result.existing === 0 && result.materialized === RULE_COUNT),
      ).toBe(true);

      const latencies = results.map((result) => result.latencyMs);
      const p50Ms = percentile(latencies, 0.5);
      const p95Ms = percentile(latencies, 0.95);
      const maxMs = Math.max(...latencies);
      const totalMs = completedAt - roundStartedAt;
      expect(p95Ms).toBeLessThanOrEqual(LOCK_WAIT_INCLUSIVE_P95_BUDGET_MS);
      expect(maxMs).toBeLessThanOrEqual(LOCK_WAIT_INCLUSIVE_MAX_BUDGET_MS);
      expect(totalMs).toBeLessThanOrEqual(ROUND_TOTAL_BUDGET_MS);

      await withBuilder(builderId, async (tx) => {
        const rows = await tx<
          {
            account_count: string;
            customer_count: string;
            evidence_count: string;
            evidence_valid: boolean;
            natural_identity_count: string;
            rule_count: string;
            shape_valid: boolean;
            zeroed: boolean;
          }[]
        >`
            SELECT COUNT(*)::TEXT AS account_count,
                   COUNT(DISTINCT account.rule_key)::TEXT AS rule_count,
                   COUNT(DISTINCT account.subject_customer_id)::TEXT AS customer_count,
                   COUNT(DISTINCT (
                     account.rule_key, account.subject_customer_id,
                     account.period, account.period_start
                   ))::TEXT AS natural_identity_count,
                   COUNT(evidence.account_id)::TEXT AS evidence_count,
                   BOOL_AND(
                     account.scope = 'per_customer'
                     AND account.subject_customer_id IS NOT NULL
                     AND account.period = 'hour'
                     AND account.created_at >= account.period_start
                     AND account.created_at < account.period_end
                   ) AS shape_valid,
                   BOOL_AND(
                     account.opening_committed_usd = 0
                     AND account.committed_usd = 0
                     AND account.reserved_usd = 0
                     AND account.unresolved_usd = 0
                     AND account.version = 0
                   ) AS zeroed,
                   BOOL_AND(
                     evidence.source = 'post_cutover_zero'
                     AND evidence.opening_committed_usd = 0
                     AND evidence.opening_committed_usd = account.opening_committed_usd
                     AND evidence.measured_through = cutover.cutover_at
                     AND evidence.evidence_snapshot_hash =
                       public.pylva_budget_jsonb_sha256(evidence.evidence_snapshot)
                   ) AS evidence_valid
            FROM public.budget_accounts account
            JOIN public.budget_account_opening_evidence evidence
              ON evidence.builder_id = account.builder_id
             AND evidence.account_id = account.id
            JOIN public.budget_control_cutovers cutover
              ON cutover.builder_id = account.builder_id
            WHERE account.builder_id = ${builderId}::UUID
          `;
        expect(rows[0]).toEqual({
          account_count: String(RULE_COUNT * CUSTOMER_COUNT),
          customer_count: String(CUSTOMER_COUNT),
          evidence_count: String(RULE_COUNT * CUSTOMER_COUNT),
          evidence_valid: true,
          natural_identity_count: String(RULE_COUNT * CUSTOMER_COUNT),
          rule_count: String(RULE_COUNT),
          shape_valid: true,
          zeroed: true,
        });
      });

      const replayStartedAt = performance.now();
      const replay = await Promise.all(
        customerIds.map((customerId) => materializeTimed(builderId, customerId)),
      );
      const replayTotalMs = performance.now() - replayStartedAt;
      expect(
        replay.every((result) => result.existing === RULE_COUNT && result.materialized === 0),
      ).toBe(true);
      await withBuilder(builderId, async (tx) => {
        const rows = await tx<{ accounts: string; evidence: string }[]>`
            SELECT
              (SELECT COUNT(*)::TEXT FROM public.budget_accounts
               WHERE builder_id = ${builderId}::UUID) AS accounts,
              (SELECT COUNT(*)::TEXT FROM public.budget_account_opening_evidence
               WHERE builder_id = ${builderId}::UUID) AS evidence
          `;
        expect(rows[0]).toEqual({
          accounts: String(RULE_COUNT * CUSTOMER_COUNT),
          evidence: String(RULE_COUNT * CUSTOMER_COUNT),
        });
      });

      roundMetrics.push({
        forced_lock_hold_ms: Math.round(forcedLockHoldMs),
        max_ms: Math.round(maxMs),
        p50_ms: Math.round(p50Ms),
        p95_ms: Math.round(p95Ms),
        replay_total_ms: Math.round(replayTotalMs),
        round: round + 1,
        total_ms: Math.round(totalMs),
      });
    }

    console.info(
      '[budget-load-gate] hourly per-customer first use',
      JSON.stringify({
        accounts_per_round: RULE_COUNT * CUSTOMER_COUNT,
        budgets_ms: {
          max: LOCK_WAIT_INCLUSIVE_MAX_BUDGET_MS,
          p95: LOCK_WAIT_INCLUSIVE_P95_BUDGET_MS,
          total: ROUND_TOTAL_BUDGET_MS,
        },
        customers: CUSTOMER_COUNT,
        rounds: roundMetrics,
        rules: RULE_COUNT,
      }),
    );
  }, 120_000);
});
