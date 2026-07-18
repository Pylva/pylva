import crypto from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RuleEnforcement, RuleStatus, RuleType } from '@pylva/shared';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

// This suite always injects a disposable local database and never exercises
// the optional production Secrets Manager password refresher.
vi.mock('../../src/lib/db/credentials.js', () => ({ getDbPassword: vi.fn() }));

type RulesRepository = typeof import('../../src/lib/rules/repository.js');
type RuleRevisionModule = typeof import('../../src/lib/budget-control/rule-revisions.js');
type TransactionModule = typeof import('../../src/lib/budget-control/transaction.js');

const ORIGINAL_DATABASE_URL = process.env['DATABASE_URL'];
const ORIGINAL_MIGRATION_DATABASE_URL = process.env['MIGRATION_DATABASE_URL'];
const ORIGINAL_BUDGET_CONTROL_DATABASE_URL = process.env['BUDGET_CONTROL_DATABASE_URL'];
const ORIGINAL_BUDGET_CONTROL_SECRET_ARN = process.env['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN'];
const ORIGINAL_ALLOW_BUDGET_CONTROL_FALLBACK =
  process.env['ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK'];

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface AuditRow {
  table_name: string;
  operation: string;
  transaction_id: string;
}

interface MutableRow {
  type: string;
  enforcement: string;
  name: string;
  enabled: boolean;
  customer_id: string | null;
  status: string;
  config: Record<string, unknown>;
}

interface RevisionRow {
  revision: string;
  enforcement: string;
  limit_usd: string;
  retirement_reason: string | null;
  retired_at: Date | null;
  config_exact: boolean;
  successor_boundary_exact: boolean | null;
}

let scratch: ScratchDb | undefined;
let sql: Sql;
let repository: RulesRepository;
let revisionModule: RuleRevisionModule;
let transactionModule: TransactionModule;
let closeDb: (() => Promise<void>) | undefined;
let closeBudgetControlDb: (() => Promise<void>) | undefined;
let builderA = '';
let builderB = '';

function db(): Sql {
  if (!scratch) throw new Error('authoritative rule repository scratch database is unavailable');
  return sql;
}

function budgetConfig(
  limitUsd: number,
  options: {
    period?: 'hour' | 'day' | 'week' | 'month';
    hardStop?: boolean;
    scope?: 'pooled' | 'per_customer';
  } = {},
): Record<string, unknown> {
  return {
    limit_usd: limitUsd,
    period: options.period ?? 'day',
    hard_stop: options.hardStop ?? true,
    scope: options.scope ?? 'per_customer',
  };
}

async function createBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await db()<[{ id: string }]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (${`${label}-${suffix}@example.com`}, ${label}, 'pro', ${`${label}-${suffix}`})
    RETURNING id::TEXT AS id
  `;
  if (!row) throw new Error('builder fixture insert returned no row');
  return row.id;
}

async function mutableRule(builderId: string, ruleKey: string): Promise<MutableRow | null> {
  const rows = await db()<MutableRow[]>`
    SELECT type, enforcement, name, enabled, customer_id, status, config
    FROM public.rules
    WHERE builder_id = ${builderId}::UUID AND id = ${ruleKey}::UUID
  `;
  return rows[0] ?? null;
}

async function revisions(builderId: string, ruleKey: string): Promise<RevisionRow[]> {
  return db().begin(async (transaction) => {
    await transaction`
      SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
    `;
    return transaction<RevisionRow[]>`
      SELECT current.revision::TEXT AS revision,
             current.enforcement,
             public.pylva_budget_decimal_text(current.limit_usd) AS limit_usd,
             current.retirement_reason,
             current.retired_at,
             current.config_snapshot_hash =
               public.pylva_budget_jsonb_sha256(current.config_snapshot) AS config_exact,
             CASE WHEN previous.id IS NULL THEN NULL
               ELSE previous.retired_at = current.active_from
             END AS successor_boundary_exact
      FROM public.budget_rule_revisions current
      LEFT JOIN public.budget_rule_revisions previous
        ON previous.builder_id = current.builder_id
       AND previous.rule_key = current.rule_key
       AND previous.revision = current.revision - 1
      WHERE current.builder_id = ${builderId}::UUID
        AND current.rule_key = ${ruleKey}::UUID
      ORDER BY current.revision
    `;
  });
}

async function clearAudit(): Promise<void> {
  await db()`DELETE FROM public.test_rule_revision_tx_audit`;
}

async function auditRows(): Promise<AuditRow[]> {
  return db()<AuditRow[]>`
    SELECT table_name, operation, transaction_id::TEXT AS transaction_id
    FROM public.test_rule_revision_tx_audit
    ORDER BY id
  `;
}

async function expectOneAtomicMutation(expectedEvents: string[]): Promise<void> {
  const rows = await auditRows();
  expect(rows.map((row) => `${row.table_name}:${row.operation}`).sort()).toEqual(
    [...expectedEvents].sort(),
  );
  expect(new Set(rows.map((row) => row.transaction_id))).toHaveLength(1);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectStillWaiting(promise: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const,
    ),
    new Promise<'waiting'>((resolve) => {
      setTimeout(() => resolve('waiting'), 100);
    }),
  ]);
  expect(outcome).toBe('waiting');
}

beforeAll(async () => {
  const candidate = await createScratchDb({ prefix: 'authoritative_rule_repository' });
  try {
    await applyMigrationsThrough(candidate, '051');
    process.env['DATABASE_URL'] = candidate.url;
    process.env['ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK'] = 'true';
    // This scratch suite intentionally proves the explicit local/CI fallback
    // through the dedicated authoritative pool. Its exact object assertions
    // protect the raw JSON-text transport boundary independently of either
    // pool's serializer configuration. Never let ambient credentials redirect
    // it outside the disposable database.
    delete process.env['BUDGET_CONTROL_DATABASE_URL'];
    delete process.env['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN'];
    delete process.env['MIGRATION_DATABASE_URL'];
    repository = await import('../../src/lib/rules/repository.js');
    revisionModule = await import('../../src/lib/budget-control/rule-revisions.js');
    transactionModule = await import('../../src/lib/budget-control/transaction.js');
    ({ closeDb } = await import('../../src/lib/db/client.js'));
    ({ closeBudgetControlDb } = await import('../../src/lib/budget-control/client.js'));
    scratch = candidate;
    sql = candidate.sql;

    await db().unsafe(`
      CREATE TABLE public.test_rule_revision_tx_audit (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        table_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        builder_id UUID NOT NULL,
        rule_key UUID NOT NULL,
        transaction_id BIGINT NOT NULL
      );

      CREATE OR REPLACE FUNCTION public.test_capture_rule_revision_transaction()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $audit$
      DECLARE
        row_value JSONB;
      BEGIN
        row_value := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

        INSERT INTO public.test_rule_revision_tx_audit (
          table_name, operation, builder_id, rule_key, transaction_id
        ) VALUES (
          TG_TABLE_NAME,
          TG_OP,
          (row_value->>'builder_id')::UUID,
          COALESCE(row_value->>'rule_key', row_value->>'id')::UUID,
          txid_current()
        );
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END;
      $audit$;

      CREATE TRIGGER test_rules_transaction_audit
      AFTER INSERT OR UPDATE OR DELETE ON public.rules
      FOR EACH ROW EXECUTE FUNCTION public.test_capture_rule_revision_transaction();

      CREATE TRIGGER test_budget_rule_revisions_transaction_audit
      AFTER INSERT OR UPDATE ON public.budget_rule_revisions
      FOR EACH ROW EXECUTE FUNCTION public.test_capture_rule_revision_transaction();
    `);

    builderA = await createBuilder('authoritative-rules-a');
    builderB = await createBuilder('authoritative-rules-b');
  } catch (error) {
    await closeBudgetControlDb?.();
    await closeDb?.();
    await candidate.drop();
    restoreEnvironment('DATABASE_URL', ORIGINAL_DATABASE_URL);
    restoreEnvironment('MIGRATION_DATABASE_URL', ORIGINAL_MIGRATION_DATABASE_URL);
    restoreEnvironment('BUDGET_CONTROL_DATABASE_URL', ORIGINAL_BUDGET_CONTROL_DATABASE_URL);
    restoreEnvironment(
      'BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN',
      ORIGINAL_BUDGET_CONTROL_SECRET_ARN,
    );
    restoreEnvironment(
      'ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK',
      ORIGINAL_ALLOW_BUDGET_CONTROL_FALLBACK,
    );
    throw error;
  }
});

afterAll(async () => {
  await closeBudgetControlDb?.();
  await closeDb?.();
  await scratch?.drop();
  scratch = undefined;
  restoreEnvironment('DATABASE_URL', ORIGINAL_DATABASE_URL);
  restoreEnvironment('MIGRATION_DATABASE_URL', ORIGINAL_MIGRATION_DATABASE_URL);
  restoreEnvironment('BUDGET_CONTROL_DATABASE_URL', ORIGINAL_BUDGET_CONTROL_DATABASE_URL);
  restoreEnvironment(
    'BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN',
    ORIGINAL_BUDGET_CONTROL_SECRET_ARN,
  );
  restoreEnvironment(
    'ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK',
    ORIGINAL_ALLOW_BUDGET_CONTROL_FALLBACK,
  );
});

describe('atomic mutable rules and immutable authoritative revisions', () => {
  it('commits create, limit/enforcement rotation, disable, re-enable, and deletion atomically', async () => {
    await clearAudit();
    const created = await repository.createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'atomic lifecycle',
      customer_id: 'customer_1',
      config: budgetConfig(10),
    });
    await expectOneAtomicMutation(['rules:INSERT', 'budget_rule_revisions:INSERT']);

    await clearAudit();
    expect(
      (await repository.updateRule(builderA, created.id, { name: 'atomic lifecycle renamed' }))
        ?.name,
    ).toBe('atomic lifecycle renamed');
    await expectOneAtomicMutation(['rules:UPDATE']);
    expect(await revisions(builderA, created.id)).toHaveLength(1);

    await clearAudit();
    const rotated = await repository.updateRule(builderA, created.id, {
      config: budgetConfig(25, { hardStop: false }),
    });
    expect(rotated?.config).toEqual(budgetConfig(25, { hardStop: false }));
    await expectOneAtomicMutation([
      'rules:UPDATE',
      'budget_rule_revisions:UPDATE',
      'budget_rule_revisions:INSERT',
    ]);

    await clearAudit();
    expect((await repository.toggleRule(builderA, created.id, false))?.enabled).toBe(false);
    await expectOneAtomicMutation(['rules:UPDATE', 'budget_rule_revisions:UPDATE']);

    await clearAudit();
    expect((await repository.toggleRule(builderA, created.id, true))?.enabled).toBe(true);
    await expectOneAtomicMutation(['rules:UPDATE', 'budget_rule_revisions:INSERT']);

    await clearAudit();
    await expect(repository.deleteRule(builderA, created.id)).resolves.toBe(true);
    await expectOneAtomicMutation(['rules:DELETE', 'budget_rule_revisions:UPDATE']);

    expect(await mutableRule(builderA, created.id)).toBeNull();
    expect(await revisions(builderA, created.id)).toEqual([
      {
        revision: '0',
        enforcement: 'hard_stop',
        limit_usd: '10',
        retirement_reason: 'superseded',
        retired_at: expect.any(Date),
        config_exact: true,
        successor_boundary_exact: null,
      },
      {
        revision: '1',
        enforcement: 'advisory',
        limit_usd: '25',
        retirement_reason: 'disabled',
        retired_at: expect.any(Date),
        config_exact: true,
        successor_boundary_exact: true,
      },
      {
        revision: '2',
        enforcement: 'advisory',
        limit_usd: '25',
        retirement_reason: 'deleted',
        retired_at: expect.any(Date),
        config_exact: true,
        successor_boundary_exact: expect.any(Boolean),
      },
    ]);
  });

  it('rolls back scope, target, period, type, and malformed-config writes completely', async () => {
    const originalConfig = budgetConfig(40);
    const created = await repository.createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'immutable structure',
      customer_id: 'customer_a',
      config: originalConfig,
    });
    const original = await mutableRule(builderA, created.id);

    const expectRolledBack = async (
      mutation: () => Promise<unknown>,
      errorType: new (...args: never[]) => Error,
    ): Promise<void> => {
      await clearAudit();
      await expect(mutation()).rejects.toBeInstanceOf(errorType);
      expect(await mutableRule(builderA, created.id)).toEqual(original);
      expect(await revisions(builderA, created.id)).toHaveLength(1);
      expect(await auditRows()).toEqual([]);
    };

    await expectRolledBack(
      () =>
        repository.updateRule(builderA, created.id, {
          customer_id: null,
          config: budgetConfig(40, { scope: 'pooled' }),
        }),
      revisionModule.BudgetRuleStructuralChangeError,
    );
    await expectRolledBack(
      () => repository.updateRule(builderA, created.id, { customer_id: 'customer_b' }),
      revisionModule.BudgetRuleStructuralChangeError,
    );
    await expectRolledBack(
      () =>
        repository.updateRule(builderA, created.id, {
          config: budgetConfig(40, { period: 'week' }),
        }),
      revisionModule.BudgetRuleStructuralChangeError,
    );
    await expectRolledBack(
      () =>
        revisionModule.withBudgetRuleRevisionMutation(builderA, created.id, async (transaction) => {
          const rows = await transaction<{ id: string }[]>`
            UPDATE public.rules
            SET type = 'cost_threshold', updated_at = pg_catalog.transaction_timestamp()
            WHERE builder_id = ${builderA}::UUID AND id = ${created.id}::UUID
            RETURNING id::TEXT AS id
          `;
          return { kind: 'upsert', value: rows[0]?.id ?? null };
        }),
      revisionModule.BudgetRuleStructuralChangeError,
    );
    await expectRolledBack(
      () =>
        repository.updateRule(builderA, created.id, {
          config: { ...originalConfig, hard_stop: 'yes' },
        }),
      revisionModule.BudgetRuleConfigurationError,
    );

    await repository.deleteRule(builderA, created.id);
  });

  it('preserves the existing non-budget repository lifecycle without creating authority rows', async () => {
    const created = await repository.createRule({
      builder_id: builderA,
      type: RuleType.COST_THRESHOLD,
      name: 'ordinary reactive rule',
      customer_id: 'customer_a',
      config: { threshold_usd: 5, period: 'day', scope: 'per_customer' },
    });
    expect(created.enforcement).toBe(RuleEnforcement.POST_CALL);
    expect(await revisions(builderA, created.id)).toEqual([]);

    const updated = await repository.updateRule(builderA, created.id, {
      name: 'ordinary reactive rule updated',
      customer_id: 'customer_b',
      config: { threshold_usd: 7, period: 'week', scope: 'per_customer' },
    });
    expect(updated).toMatchObject({
      name: 'ordinary reactive rule updated',
      customer_id: 'customer_b',
      config: { threshold_usd: 7, period: 'week', scope: 'per_customer' },
    });
    expect((await repository.toggleRule(builderA, created.id, false))?.enabled).toBe(false);
    expect(
      (await repository.promoteRuleStatus(builderA, created.id, RuleStatus.DRAFT))?.status,
    ).toBe(RuleStatus.DRAFT);
    expect(
      (await repository.promoteRuleStatus(builderA, created.id, RuleStatus.ACTIVE))?.status,
    ).toBe(RuleStatus.ACTIVE);
    expect(await revisions(builderA, created.id)).toEqual([]);
    await expect(repository.deleteRule(builderA, created.id)).resolves.toBe(true);
    expect(await mutableRule(builderA, created.id)).toBeNull();
    expect(await revisions(builderA, created.id)).toEqual([]);
  });

  it('turns cross-tenant mutation attempts into no-ops without touching either history', async () => {
    const created = await repository.createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'tenant-owned rule',
      config: budgetConfig(50, { scope: 'pooled' }),
    });
    const before = await mutableRule(builderA, created.id);
    const historyBefore = await revisions(builderA, created.id);
    await clearAudit();

    await expect(
      repository.updateRule(builderB, created.id, { name: 'stolen' }),
    ).resolves.toBeNull();
    await expect(repository.toggleRule(builderB, created.id, false)).resolves.toBeNull();
    await expect(
      repository.promoteRuleStatus(builderB, created.id, RuleStatus.DRAFT),
    ).resolves.toBeNull();
    await expect(repository.deleteRule(builderB, created.id)).resolves.toBe(false);

    expect(await mutableRule(builderA, created.id)).toEqual(before);
    expect(await revisions(builderA, created.id)).toEqual(historyBefore);
    expect(await auditRows()).toEqual([]);
    await repository.deleteRule(builderA, created.id);
  });

  it('replays a rolled-back serialization failure without duplicate or partial revisions', async () => {
    const created = await repository.createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'retry-safe rule',
      config: budgetConfig(60, { scope: 'pooled' }),
    });
    await db().unsafe(`
      CREATE SEQUENCE public.test_rule_revision_retry_sequence START WITH 1;
      CREATE OR REPLACE FUNCTION public.test_raise_rule_revision_retry_once()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = pg_catalog, public
      AS $retry$
      BEGIN
        IF nextval('public.test_rule_revision_retry_sequence') = 1 THEN
          RAISE EXCEPTION 'test serialization retry' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $retry$;
      CREATE TRIGGER a_test_rule_revision_retry_once
      BEFORE UPDATE ON public.budget_rule_revisions
      FOR EACH ROW EXECUTE FUNCTION public.test_raise_rule_revision_retry_once();
    `);

    await clearAudit();
    try {
      const updated = await repository.updateRule(builderA, created.id, {
        name: 'retry-safe rule committed once',
        config: budgetConfig(75, { hardStop: false, scope: 'pooled' }),
      });
      expect(updated).toMatchObject({
        name: 'retry-safe rule committed once',
        config: budgetConfig(75, { hardStop: false, scope: 'pooled' }),
      });
    } finally {
      await db()`
        DROP TRIGGER IF EXISTS a_test_rule_revision_retry_once
        ON public.budget_rule_revisions
      `;
      await db()`DROP FUNCTION IF EXISTS public.test_raise_rule_revision_retry_once()`;
    }

    const [sequence] = await db()<[{ last_value: string }]>`
      SELECT last_value::TEXT AS last_value
      FROM public.test_rule_revision_retry_sequence
    `;
    expect(sequence?.last_value).toBe('2');
    await expectOneAtomicMutation([
      'rules:UPDATE',
      'budget_rule_revisions:UPDATE',
      'budget_rule_revisions:INSERT',
    ]);
    expect(await revisions(builderA, created.id)).toMatchObject([
      { revision: '0', limit_usd: '60', retirement_reason: 'superseded' },
      { revision: '1', limit_usd: '75', retirement_reason: null },
    ]);
    await repository.deleteRule(builderA, created.id);
  });

  it('takes the exclusive builder lock and serializes concurrent policy rotations', async () => {
    const holderAcquired = deferred();
    const releaseHolder = deferred();
    let holder: Promise<unknown> | undefined;
    let pendingCreate: Promise<Awaited<ReturnType<RulesRepository['createRule']>>> | undefined;

    try {
      holder = transactionModule.withBudgetBuilderTransaction(builderA, 'shared', async () => {
        holderAcquired.resolve();
        await releaseHolder.promise;
      });
      await holderAcquired.promise;

      pendingCreate = repository.createRule({
        builder_id: builderA,
        type: RuleType.BUDGET_LIMIT,
        name: 'lock-serialized rule',
        config: budgetConfig(80, { scope: 'pooled' }),
      });
      await expectStillWaiting(pendingCreate);
      releaseHolder.resolve();
      await expect(holder).resolves.toBeUndefined();
    } finally {
      releaseHolder.resolve();
      await Promise.allSettled([holder].filter(Boolean) as Promise<unknown>[]);
    }

    const created = await pendingCreate!;
    await clearAudit();
    const [first, second] = await Promise.all([
      repository.updateRule(builderA, created.id, {
        config: budgetConfig(90, { scope: 'pooled' }),
      }),
      repository.updateRule(builderA, created.id, {
        config: budgetConfig(100, { hardStop: false, scope: 'pooled' }),
      }),
    ]);
    expect(first?.config).toEqual(budgetConfig(90, { scope: 'pooled' }));
    expect(second?.config).toEqual(budgetConfig(100, { hardStop: false, scope: 'pooled' }));

    const history = await revisions(builderA, created.id);
    expect(history.map((row) => row.revision)).toEqual(['0', '1', '2']);
    expect(history.filter((row) => row.retirement_reason === null)).toHaveLength(1);
    expect(new Set(history.slice(1).map((row) => row.limit_usd))).toEqual(new Set(['90', '100']));

    const rows = await auditRows();
    const grouped = new Map<string, AuditRow[]>();
    for (const row of rows) {
      const events = grouped.get(row.transaction_id) ?? [];
      events.push(row);
      grouped.set(row.transaction_id, events);
    }
    expect(grouped.size).toBe(2);
    for (const events of grouped.values()) {
      expect(events.map((row) => `${row.table_name}:${row.operation}`).sort()).toEqual(
        ['rules:UPDATE', 'budget_rule_revisions:UPDATE', 'budget_rule_revisions:INSERT'].sort(),
      );
    }
    await repository.deleteRule(builderA, created.id);
  });
});
