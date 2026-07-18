import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres, { type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';
import { ensureRlsTestRole, RLS_TEST_USER, rlsDatabaseUrl } from '../helpers/rls-test-role.js';

const LEDGER_MIGRATION = '050_authoritative_budget_control_ledger.sql';
const RUNTIME_MIGRATION = '051_authoritative_budget_control_runtime.sql';
const TEST_TIMEOUT_MS = 180_000;

type Db = ScratchDb['sql'];
type RuntimeSql = Db | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;

interface RuleFixture {
  id: string;
  key: string;
  period: 'hour' | 'day' | 'week' | 'month';
}

interface PeriodFixture {
  end: string;
  start: string;
}

let scratch: ScratchDb | undefined;

function db(): Db {
  if (!scratch) throw new Error('authoritative runtime scratch database is not ready');
  return scratch.sql;
}

async function expectPgError(
  action: Promise<unknown>,
  code: string,
  message: RegExp,
): Promise<void> {
  try {
    await action;
  } catch (error) {
    const pgError = error as { code?: unknown; message?: unknown };
    expect(pgError.code).toBe(code);
    expect(String(pgError.message)).toMatch(message);
    return;
  }
  throw new Error(`Expected PostgreSQL ${code}: ${message.source}`);
}

async function useBuilder(sql: RuntimeSql, builderId: string): Promise<void> {
  await sql`SELECT set_config('app.builder_id', ${builderId}, true)`;
}

async function insertBuilder(sql: Db, label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO public.builders (email, name, slug)
    VALUES (
      ${`runtime-${label}-${suffix}@example.com`},
      ${`Runtime ${label}`},
      ${`runtime-${label}-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  if (!row) throw new Error('builder fixture was not inserted');
  return row.id;
}

async function insertRule(
  sql: RuntimeSql,
  builderId: string,
  period: RuleFixture['period'],
): Promise<RuleFixture> {
  const id = crypto.randomUUID();
  const key = crypto.randomUUID();
  const snapshot = {
    schema_version: '1.0',
    rule_key: key,
    scope: 'pooled',
    target_customer_id: null,
    period,
    enforcement: 'hard_stop',
    limit_usd: '10',
  } as const;
  await sql`
    INSERT INTO public.budget_rule_revisions (
      builder_id, id, rule_key, revision, scope, target_customer_id,
      period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
    )
    VALUES (
      ${builderId}, ${id}, ${key}, 0, 'pooled', NULL,
      ${period}, 'hard_stop', '10', ${sql.json(snapshot)}::JSONB,
      public.pylva_budget_jsonb_sha256(${sql.json(snapshot)}::JSONB)
    )
  `;
  return { id, key, period };
}

async function ruleAuthorityOrder(
  sql: RuntimeSql,
  builderId: string,
  ruleId: string,
): Promise<string> {
  const [row] = await sql<{ value: string }[]>`
    SELECT authority_order::TEXT AS value
    FROM public.budget_rule_revisions
    WHERE builder_id = ${builderId} AND id = ${ruleId}
  `;
  if (!row) throw new Error('rule authority order was not returned');
  return row.value;
}

async function insertRuleWithForgedAuthorityOrder(
  sql: RuntimeSql,
  builderId: string,
  period: RuleFixture['period'],
  forgedOrder: string,
): Promise<RuleFixture> {
  const id = crypto.randomUUID();
  const key = crypto.randomUUID();
  const snapshot = {
    schema_version: '1.0',
    rule_key: key,
    scope: 'pooled',
    target_customer_id: null,
    period,
    enforcement: 'hard_stop',
    limit_usd: '10',
  } as const;
  await sql`
    INSERT INTO public.budget_rule_revisions (
      builder_id, id, rule_key, revision, authority_order,
      scope, target_customer_id, period, enforcement, limit_usd,
      config_snapshot, config_snapshot_hash
    )
    VALUES (
      ${builderId}, ${id}, ${key}, 0, ${forgedOrder},
      'pooled', NULL, ${period}, 'hard_stop', '10',
      ${sql.json(snapshot)}::JSONB,
      public.pylva_budget_jsonb_sha256(${sql.json(snapshot)}::JSONB)
    )
  `;
  return { id, key, period };
}

async function rotateRule(
  sql: RuntimeSql,
  builderId: string,
  origin: RuleFixture,
): Promise<RuleFixture> {
  await sql`
    UPDATE public.budget_rule_revisions
    SET retirement_reason = 'superseded'
    WHERE builder_id = ${builderId} AND id = ${origin.id}
  `;
  const id = crypto.randomUUID();
  const snapshot = {
    schema_version: '1.0',
    rule_key: origin.key,
    scope: 'pooled',
    target_customer_id: null,
    period: origin.period,
    enforcement: 'hard_stop',
    limit_usd: '10',
  } as const;
  await sql`
    INSERT INTO public.budget_rule_revisions (
      builder_id, id, rule_key, revision, scope, target_customer_id,
      period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
    )
    VALUES (
      ${builderId}, ${id}, ${origin.key}, 0, 'pooled', NULL,
      ${origin.period}, 'hard_stop', '10', ${sql.json(snapshot)}::JSONB,
      public.pylva_budget_jsonb_sha256(${sql.json(snapshot)}::JSONB)
    )
  `;
  return { id, key: origin.key, period: origin.period };
}

async function currentPeriod(
  sql: RuntimeSql,
  period: RuleFixture['period'],
): Promise<PeriodFixture> {
  const [row] = await sql<{ end: string; start: string }[]>`
    WITH period_start AS (
      SELECT CASE ${period}
        WHEN 'hour' THEN date_trunc('hour', clock_timestamp() AT TIME ZONE 'UTC')
          AT TIME ZONE 'UTC'
        WHEN 'day' THEN date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC')
          AT TIME ZONE 'UTC'
        WHEN 'week' THEN date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC')
          AT TIME ZONE 'UTC'
        WHEN 'month' THEN date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')
          AT TIME ZONE 'UTC'
      END AS value
    )
    SELECT public.pylva_budget_timestamp_text(value) AS start,
           public.pylva_budget_timestamp_text(
             CASE ${period}
               WHEN 'hour' THEN value + INTERVAL '1 hour'
               WHEN 'day' THEN value + INTERVAL '1 day'
               WHEN 'week' THEN value + INTERVAL '7 days'
               WHEN 'month' THEN (
                 (value AT TIME ZONE 'UTC') + INTERVAL '1 month'
               ) AT TIME ZONE 'UTC'
             END
           ) AS end
    FROM period_start
  `;
  if (!row) throw new Error('current period fixture was not returned');
  return row;
}

async function insertAccount(
  sql: RuntimeSql,
  builderId: string,
  rule: RuleFixture,
  period: PeriodFixture,
  openingUsd: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const snapshot = {
    schema_version: '1.0',
    rule_key: rule.key,
    scope: 'pooled',
    subject_customer_id: null,
    period: rule.period,
    period_start: period.start,
    period_end: period.end,
    enforcement: 'hard_stop',
    limit_usd: '10',
    opening_committed_usd: openingUsd,
  } as const;
  await sql`
    INSERT INTO public.budget_accounts (
      builder_id, id, rule_key, enforcement, limit_usd, scope,
      subject_customer_id, period, period_start, period_end,
      initial_rule_revision_id, initial_rule_snapshot,
      initial_rule_snapshot_hash, opening_committed_usd,
      committed_usd, reserved_usd, unresolved_usd
    )
    VALUES (
      ${builderId}, ${id}, ${rule.key}, 'hard_stop', '10', 'pooled',
      NULL, ${rule.period}, ${period.start}, ${period.end},
      ${rule.id}, ${sql.json(snapshot)}::JSONB,
      public.pylva_budget_jsonb_sha256(${sql.json(snapshot)}::JSONB),
      ${openingUsd}, ${openingUsd}, 0, 0
    )
  `;
  return id;
}

async function openingEvidenceSnapshot(
  sql: RuntimeSql,
  builderId: string,
  accountId: string,
  rule: RuleFixture,
  period: PeriodFixture,
  source: 'post_cutover_zero' | 'exact_backfill',
  cutoverAt: string,
  openingUsd: string,
): Promise<JsonObject> {
  const [row] = await sql<{ opening_usd: string }[]>`
    SELECT public.pylva_budget_decimal_text(${openingUsd}::NUMERIC) AS opening_usd
  `;
  if (!row) throw new Error('canonical opening amount was not returned');
  return {
    schema_version: '1.0',
    source,
    builder_id: builderId,
    account_id: accountId,
    rule_key: rule.key,
    scope: 'pooled',
    subject_customer_id: null,
    period: rule.period,
    period_start: period.start,
    period_end: period.end,
    cutover_at: cutoverAt,
    measured_through: cutoverAt,
    opening_committed_usd: row.opening_usd,
  };
}

async function insertOpeningEvidence(
  sql: RuntimeSql,
  builderId: string,
  accountId: string,
  rule: RuleFixture,
  period: PeriodFixture,
  source: 'post_cutover_zero' | 'exact_backfill',
  cutoverAt: string,
  openingUsd: string,
  snapshotOverride?: JsonObject,
): Promise<void> {
  const snapshot =
    snapshotOverride ??
    (await openingEvidenceSnapshot(
      sql,
      builderId,
      accountId,
      rule,
      period,
      source,
      cutoverAt,
      openingUsd,
    ));
  await sql`
    INSERT INTO public.budget_account_opening_evidence (
      builder_id, account_id, source, opening_committed_usd,
      measured_through, evidence_snapshot, evidence_snapshot_hash
    )
    VALUES (
      ${builderId}, ${accountId}, ${source}, ${openingUsd},
      ${cutoverAt}, ${sql.json(snapshot)}::JSONB,
      public.pylva_budget_jsonb_sha256(${sql.json(snapshot)}::JSONB)
    )
  `;
}

async function readCutover(
  sql: RuntimeSql,
  builderId: string,
): Promise<{
  cutover_at: string;
  mode: string;
  ready_at: string | null;
  ready_order: string | null;
  status: string;
}> {
  const [row] = await sql<
    {
      cutover_at: string;
      mode: string;
      ready_at: string | null;
      ready_order: string | null;
      status: string;
    }[]
  >`
    SELECT status, mode,
           public.pylva_budget_timestamp_text(cutover_at) AS cutover_at,
           CASE WHEN ready_at IS NULL THEN NULL
             ELSE public.pylva_budget_timestamp_text(ready_at)
           END AS ready_at,
           ready_order::TEXT AS ready_order
    FROM public.budget_control_cutovers
    WHERE builder_id = ${builderId}
  `;
  if (!row) throw new Error('cutover fixture was not returned');
  return row;
}

async function createExactCutover(sql: RuntimeSql, builderId: string): Promise<string> {
  await sql`
    INSERT INTO public.budget_control_cutovers (builder_id, mode)
    VALUES (${builderId}, 'exact_backfill')
  `;
  return (await readCutover(sql, builderId)).cutover_at;
}

async function markExactReady(sql: RuntimeSql, builderId: string): Promise<string> {
  const cutoverAt = (await readCutover(sql, builderId)).cutover_at;
  const snapshot = {
    schema_version: '1.0',
    builder_id: builderId,
    mode: 'exact_backfill',
    cutover_at: cutoverAt,
    reconciled_through: cutoverAt,
  } as const;
  await sql`
    UPDATE public.budget_control_cutovers
    SET status = 'ready',
        ready_order = 9223372036854775806,
        reconciled_through = cutover_at,
        reconciliation_snapshot = ${sql.json(snapshot)}::JSONB,
        reconciliation_snapshot_hash =
          public.pylva_budget_jsonb_sha256(${sql.json(snapshot)}::JSONB)
    WHERE builder_id = ${builderId}
  `;
  return cutoverAt;
}

async function insertBypassReservation(
  sql: RuntimeSql,
  builderId: string,
  reason: 'no_applicable_budget' | 'shadow_control_unavailable',
): Promise<string> {
  const decisionId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const spanId = crypto.randomUUID();
  const mode = reason === 'shadow_control_unavailable' ? 'shadow' : 'enforce';
  const request = {
    schema_version: '1.0',
    mode,
    operation_id: operationId,
    customer_id: 'customer_1',
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: null,
    step_name: null,
    framework: 'none',
    reservation_ttl_seconds: 300,
    kind: 'llm',
    provider: 'openai',
    model: 'gpt-4o-mini',
    estimated_input_tokens: 10,
    max_output_tokens: 10,
  } as const;
  const response = {
    schema_version: '1.0',
    decision: 'bypassed',
    allowed: true,
    decision_id: decisionId,
    operation_id: operationId,
    reason,
    would_have_denied: null,
    warnings: [],
  } as const;
  await sql`
    INSERT INTO public.budget_reservations (
      builder_id, decision_id, operation_id, schema_version,
      request_hash, request_snapshot, mode, kind, customer_id,
      trace_id, span_id, parent_span_id, step_name, framework,
      reservation_ttl_seconds, provider, model,
      estimated_input_tokens, max_output_tokens,
      decision, decision_reason, would_have_denied,
      pricing_snapshot, pricing_snapshot_hash, requested_usd,
      reserved_usd, actual_usd, released_usd, overage_usd,
      remaining_usd, deciding_account_id, reserve_response_snapshot
    )
    VALUES (
      ${builderId}, ${decisionId}, ${operationId}, '1.0',
      public.pylva_budget_jsonb_sha256(${sql.json(request)}::JSONB),
      ${sql.json(request)}::JSONB, ${mode}, 'llm', 'customer_1',
      ${traceId}, ${spanId}, NULL, NULL, 'none', 300,
      'openai', 'gpt-4o-mini', 10, 10,
      'bypassed', ${reason}, NULL,
      NULL, NULL, NULL, 0, 0, 0, 0, NULL, NULL,
      ${sql.json(response)}::JSONB
    )
  `;
  return decisionId;
}

async function runtimeMigrationSql(): Promise<string> {
  return fs.readFile(path.resolve('db/migrations', RUNTIME_MIGRATION), 'utf8');
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'authoritative_budget_runtime' });
  try {
    await applyMigrationsThrough(scratch, RUNTIME_MIGRATION);
  } catch (error) {
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
});

afterAll(async () => {
  await scratch?.drop();
});

describe('authoritative budget-control runtime migration 051', () => {
  it(
    'applies the widened types, removed default, validated constraints, and pinned helper metadata',
    async () => {
      const numericRows = await db()<
        {
          column_name: string;
          numeric_precision: string;
          numeric_scale: string;
          table_name: string;
        }[]
      >`
        SELECT table_name, column_name,
               numeric_precision::TEXT, numeric_scale::TEXT
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('budget_reservations', 'actual_usd'),
            ('budget_reservations', 'overage_usd'),
            ('budget_reservation_allocations', 'actual_usd'),
            ('budget_reservation_allocations', 'overage_usd'),
            ('budget_usage_ledger', 'actual_cost_usd')
          )
        ORDER BY table_name, column_name
      `;
      expect(numericRows).toHaveLength(5);
      expect(numericRows.every((row) => row.numeric_precision === '44')).toBe(true);
      expect(numericRows.every((row) => row.numeric_scale === '18')).toBe(true);

      const [openingDefault] = await db()<{ default_value: string | null }[]>`
        SELECT column_default AS default_value
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'budget_accounts'
          AND column_name = 'opening_committed_usd'
      `;
      expect(openingDefault?.default_value).toBeNull();

      const [constraintState] = await db()<{ invalid: string; not_valid: string }[]>`
        SELECT COUNT(*) FILTER (WHERE NOT convalidated)::TEXT AS not_valid,
               COUNT(*) FILTER (WHERE contype IN ('c', 'f', 'p', 'u')
                 AND convalidated IS FALSE)::TEXT AS invalid
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid IN (
            'public.budget_control_cutovers'::regclass,
            'public.budget_account_opening_evidence'::regclass
          )
      `;
      expect(constraintState).toEqual({ invalid: '0', not_valid: '0' });

      const [sequenceState] = await db()<
        {
          increment_by: string;
          max_value: string;
          min_value: string;
          owned_by_column: boolean;
          owner_has_usage: boolean;
          owned_by_current_user: boolean;
          public_has_privilege: boolean;
          sequence_cycles: boolean;
        }[]
      >`
        SELECT pg_get_userbyid(sequence.relowner) = current_user AS owned_by_current_user,
               has_sequence_privilege(
                 current_user,
                 sequence.oid,
                 'USAGE'
               ) AS owner_has_usage,
               settings.seqmin::TEXT AS min_value,
               settings.seqmax::TEXT AS max_value,
               settings.seqincrement::TEXT AS increment_by,
               settings.seqcycle AS sequence_cycles,
               EXISTS (
                 SELECT 1
                 FROM pg_depend dependency
                 WHERE dependency.classid = 'pg_class'::regclass
                   AND dependency.objid = sequence.oid
                   AND dependency.deptype IN ('a', 'i')
               ) AS owned_by_column,
               EXISTS (
                 SELECT 1
                 FROM aclexplode(COALESCE(
                   sequence.relacl,
                   acldefault('S', sequence.relowner)
                 )) privilege
                 WHERE privilege.grantee = 0
               ) AS public_has_privilege
        FROM pg_class sequence
        JOIN pg_sequence settings ON settings.seqrelid = sequence.oid
        WHERE sequence.oid = 'public.pylva_budget_authority_order_seq'::regclass
      `;
      expect(sequenceState).toEqual({
        increment_by: '1',
        max_value: '9223372036854775806',
        min_value: '1',
        owned_by_column: false,
        owner_has_usage: true,
        owned_by_current_user: true,
        public_has_privilege: false,
        sequence_cycles: false,
      });

      const helperRows = await db()<
        { args: string; name: string; search_path: string[] | null; volatility: string }[]
      >`
        SELECT proname AS name,
               pg_get_function_identity_arguments(oid) AS args,
               proconfig AS search_path,
               provolatile AS volatility
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN (
            'pylva_budget_next_period_boundary',
            'pylva_budget_rule_revision_authority_order_guard',
            'pylva_budget_builder_next_activation_boundary',
            'pylva_budget_cutovers_guard',
            'pylva_budget_assert_reservation_readiness',
            'pylva_budget_opening_evidence_guard',
            'pylva_budget_assert_account_opening_evidence'
          )
        ORDER BY proname
      `;
      expect(helperRows).toHaveLength(7);
      expect(helperRows.find((row) => row.name === 'pylva_budget_next_period_boundary')?.args).toBe(
        'period_name text, reference_time timestamp with time zone',
      );
      expect(
        helperRows.find((row) => row.name === 'pylva_budget_builder_next_activation_boundary')
          ?.volatility,
      ).toBe('s');
      expect(
        helperRows.every((row) =>
          row.search_path?.some((value) => value.startsWith('search_path=pg_catalog')),
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rolls the whole migration back when a pre-051 account has no typed opening evidence',
    async () => {
      const legacy = await createScratchDb({ prefix: 'runtime_preflight_account' });
      try {
        await applyMigrationsThrough(legacy, LEDGER_MIGRATION);
        const builderId = await insertBuilder(legacy.sql, 'legacy-account');
        await legacy.sql.begin(async (tx) => {
          await useBuilder(tx, builderId);
          const rule = await insertRule(tx, builderId, 'day');
          const period = await currentPeriod(tx, 'day');
          await insertAccount(tx, builderId, rule, period, '0');
        });

        const migration = await runtimeMigrationSql();
        await expectPgError(
          legacy.sql.begin((tx) => tx.unsafe(migration)),
          '55000',
          /empty pre-roll budget_accounts table/,
        );
        const [catalog] = await legacy.sql<{ cutovers: string | null; precision: string | null }[]>`
          SELECT to_regclass('public.budget_control_cutovers')::TEXT AS cutovers,
                 (
                   SELECT numeric_precision::TEXT
                   FROM information_schema.columns
                   WHERE table_schema = 'public'
                     AND table_name = 'budget_reservations'
                     AND column_name = 'actual_usd'
                 ) AS precision
        `;
        expect(catalog).toEqual({ cutovers: null, precision: '38' });
      } finally {
        await legacy.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rolls back when a pre-051 evaluated decision would be grandfathered',
    async () => {
      const legacy = await createScratchDb({ prefix: 'runtime_preflight_decision' });
      try {
        await applyMigrationsThrough(legacy, LEDGER_MIGRATION);
        const builderId = await insertBuilder(legacy.sql, 'legacy-decision');
        await legacy.sql.begin(async (tx) => {
          await useBuilder(tx, builderId);
          await insertBypassReservation(tx, builderId, 'no_applicable_budget');
        });

        const migration = await runtimeMigrationSql();
        await expectPgError(
          legacy.sql.begin((tx) => tx.unsafe(migration)),
          '55000',
          /cannot grandfather evaluated budget decisions/,
        );
        const [catalog] = await legacy.sql<{ cutovers: string | null }[]>`
          SELECT to_regclass('public.budget_control_cutovers')::TEXT AS cutovers
        `;
        expect(catalog?.cutovers).toBeNull();
      } finally {
        await legacy.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'backfills every pre-051 rule origin before any readiness order can be allocated',
    async () => {
      const legacy = await createScratchDb({ prefix: 'runtime_authority_backfill' });
      try {
        await applyMigrationsThrough(legacy, LEDGER_MIGRATION);
        const builderId = await insertBuilder(legacy.sql, 'legacy-rule');
        let rule: RuleFixture | undefined;
        await legacy.sql.begin(async (tx) => {
          await useBuilder(tx, builderId);
          rule = await insertRule(tx, builderId, 'day');
        });
        const migration = await runtimeMigrationSql();
        await legacy.sql.begin((tx) => tx.unsafe(migration));

        const [state] = await legacy.sql.begin(async (tx) => {
          await useBuilder(tx, builderId);
          await createExactCutover(tx, builderId);
          await markExactReady(tx, builderId);
          return tx<
            { authority_order: string; default_value: string | null; ready_order: string }[]
          >`
            SELECT revision.authority_order::TEXT AS authority_order,
                   column_state.column_default AS default_value,
                   cutover.ready_order::TEXT AS ready_order
            FROM public.budget_rule_revisions revision
            JOIN public.budget_control_cutovers cutover
              ON cutover.builder_id = revision.builder_id
            CROSS JOIN LATERAL (
              SELECT column_default
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'budget_rule_revisions'
                AND column_name = 'authority_order'
            ) column_state
            WHERE revision.builder_id = ${builderId} AND revision.id = ${rule!.id}
          `;
        });
        expect(state?.default_value).toBeNull();
        expect(BigInt(state!.authority_order)).toBeGreaterThan(0n);
        expect(BigInt(state!.ready_order)).toBeGreaterThan(BigInt(state!.authority_order));
      } finally {
        await legacy.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it('calculates exact UTC hour/day/week/month boundaries with the two-argument helper', async () => {
    const rows = await db()<{ boundary: string; period: string }[]>`
      SELECT period,
             public.pylva_budget_timestamp_text(
               public.pylva_budget_next_period_boundary(
                 period,
                 '2026-01-31T23:59:59.999Z'::TIMESTAMPTZ
               )
             ) AS boundary
      FROM unnest(ARRAY['hour', 'day', 'week', 'month']) AS period
      ORDER BY period
    `;
    expect(Object.fromEntries(rows.map((row) => [row.period, row.boundary]))).toEqual({
      day: '2026-02-01T00:00:00.000Z',
      hour: '2026-02-01T00:00:00.000Z',
      month: '2026-02-01T00:00:00.000Z',
      week: '2026-02-02T00:00:00.000Z',
    });
  });

  it('preserves exact UTC boundaries across leap-day entry and exit', async () => {
    const rows = await db()<{ boundary: string; label: string }[]>`
      SELECT sample.label,
             public.pylva_budget_timestamp_text(
               public.pylva_budget_next_period_boundary(
                 sample.period,
                 sample.reference_time
               )
             ) AS boundary
      FROM (
        VALUES
          ('enter_leap_day', 'day', '2024-02-28T23:59:59.999Z'::TIMESTAMPTZ),
          ('leave_leap_day', 'day', '2024-02-29T23:59:59.999Z'::TIMESTAMPTZ),
          ('leave_leap_month', 'month', '2024-02-29T23:59:59.999Z'::TIMESTAMPTZ)
      ) AS sample(label, period, reference_time)
      ORDER BY sample.label
    `;

    expect(Object.fromEntries(rows.map((row) => [row.label, row.boundary]))).toEqual({
      enter_leap_day: '2024-02-29T00:00:00.000Z',
      leave_leap_day: '2024-03-01T00:00:00.000Z',
      leave_leap_month: '2024-03-01T00:00:00.000Z',
    });
  });

  it(
    'overwrites caller order values after locking, preserves rollback gaps, and freezes ready_order',
    async () => {
      const builderId = await insertBuilder(db(), 'authority-order');
      let rolledBackOrder = '';
      await expect(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          const rule = await insertRuleWithForgedAuthorityOrder(
            tx,
            builderId,
            'day',
            '9223372036854775806',
          );
          rolledBackOrder = await ruleAuthorityOrder(tx, builderId, rule.id);
          throw new Error('force authority-order rollback');
        }),
      ).rejects.toThrow('force authority-order rollback');

      let committedRule: RuleFixture | undefined;
      let committedOrder = '';
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        committedRule = await insertRuleWithForgedAuthorityOrder(
          tx,
          builderId,
          'hour',
          '9223372036854775806',
        );
        committedOrder = await ruleAuthorityOrder(tx, builderId, committedRule.id);
      });
      expect(rolledBackOrder).not.toBe('9223372036854775806');
      expect(committedOrder).not.toBe('9223372036854775806');
      expect(BigInt(committedOrder)).toBeGreaterThan(BigInt(rolledBackOrder));

      const [rolledBackRows] = await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        return tx<{ value: string }[]>`
          SELECT COUNT(*)::TEXT AS value
          FROM public.budget_rule_revisions
          WHERE builder_id = ${builderId} AND authority_order = ${rolledBackOrder}
        `;
      });
      expect(rolledBackRows?.value).toBe('0');

      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await createExactCutover(tx, builderId);
        await markExactReady(tx, builderId);
      });
      const ready = await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        return readCutover(tx, builderId);
      });
      expect(ready.ready_order).not.toBeNull();
      expect(ready.ready_order).not.toBe('9223372036854775806');
      expect(BigInt(ready.ready_order!)).toBeGreaterThan(BigInt(committedOrder));

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            UPDATE public.budget_control_cutovers
            SET ready_order = ready_order + 1
            WHERE builder_id = ${builderId}
          `;
        }),
        '55000',
        /ready budget-control cutovers are immutable/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'owns a monotonic next-period boundary and refuses early activation, mode changes, reversal, or deletion',
    async () => {
      const builderId = await insertBuilder(db(), 'next-period');
      let firstBoundary = '';
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await insertRule(tx, builderId, 'day');
        await tx`
          INSERT INTO public.budget_control_cutovers (builder_id, mode)
          VALUES (${builderId}, 'next_period')
        `;
        firstBoundary = (await readCutover(tx, builderId)).cutover_at;
      });

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            UPDATE public.budget_control_cutovers
            SET status = 'ready'
            WHERE builder_id = ${builderId}
          `;
        }),
        '55000',
        /cannot become ready before its activation boundary/,
      );

      let refreshedBoundary = '';
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await insertRule(tx, builderId, 'month');
        await tx`
          UPDATE public.budget_control_cutovers
          SET cutover_at = '0001-01-01T00:00:00.000Z'
          WHERE builder_id = ${builderId}
        `;
        refreshedBoundary = (await readCutover(tx, builderId)).cutover_at;
      });
      expect(Date.parse(refreshedBoundary)).toBeGreaterThan(Date.parse(firstBoundary));

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            UPDATE public.budget_control_cutovers
            SET mode = 'exact_backfill'
            WHERE builder_id = ${builderId}
          `;
        }),
        '55000',
        /identity and mode are immutable/,
      );
      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`DELETE FROM public.budget_control_cutovers WHERE builder_id = ${builderId}`;
        }),
        '55000',
        /immutable and cannot be deleted/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'canonicalizes exact-backfill readiness and makes the ready row irreversible',
    async () => {
      const builderId = await insertBuilder(db(), 'exact-ready');
      let cutoverAt = '';
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        cutoverAt = await createExactCutover(tx, builderId);
      });

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          const wrong = {
            schema_version: '1.0',
            builder_id: builderId,
            mode: 'exact_backfill',
            cutover_at: cutoverAt,
            reconciled_through: '2000-01-01T00:00:00.000Z',
          } as const;
          await tx`
            UPDATE public.budget_control_cutovers
            SET status = 'ready',
                reconciled_through = '2000-01-01T00:00:00.000Z',
                reconciliation_snapshot = ${tx.json(wrong)}::JSONB,
                reconciliation_snapshot_hash =
                  public.pylva_budget_jsonb_sha256(${tx.json(wrong)}::JSONB)
            WHERE builder_id = ${builderId}
          `;
        }),
        '23514',
        /exact backfill must reconcile through the immutable cutover watermark/,
      );

      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await markExactReady(tx, builderId);
      });
      const ready = await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        return readCutover(tx, builderId);
      });
      expect(ready).toMatchObject({
        cutover_at: cutoverAt,
        mode: 'exact_backfill',
        status: 'ready',
      });
      expect(ready.ready_at).not.toBeNull();
      expect(ready.ready_order).not.toBeNull();
      expect(ready.ready_order).not.toBe('9223372036854775806');

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            UPDATE public.budget_control_cutovers
            SET status = 'pending'
            WHERE builder_id = ${builderId}
          `;
        }),
        '55000',
        /ready budget-control cutovers are immutable/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'allows honest shadow unavailability before readiness but closes every evaluated decision over readiness',
    async () => {
      const builderId = await insertBuilder(db(), 'decision-readiness');
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await insertBypassReservation(tx, builderId, 'shadow_control_unavailable');
      });

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await insertBypassReservation(tx, builderId, 'no_applicable_budget');
        }),
        '23514',
        /evaluated budget decisions require a ready authoritative cutover/,
      );

      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await createExactCutover(tx, builderId);
        await markExactReady(tx, builderId);
      });
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await insertBypassReservation(tx, builderId, 'no_applicable_budget');
      });

      const [counts] = await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        return tx<{ evaluated: string; unavailable: string }[]>`
          SELECT COUNT(*) FILTER (
                   WHERE decision_reason = 'no_applicable_budget'
                 )::TEXT AS evaluated,
                 COUNT(*) FILTER (
                   WHERE decision_reason = 'shadow_control_unavailable'
                 )::TEXT AS unavailable
          FROM public.budget_reservations
          WHERE builder_id = ${builderId}
        `;
      });
      expect(counts).toEqual({ evaluated: '1', unavailable: '1' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'requires canonical immutable evidence and accepts a stable rule ordered after readiness',
    async () => {
      const builderId = await insertBuilder(db(), 'new-rule-zero');
      let cutoverAt = '';
      let accountId = '';
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        cutoverAt = await createExactCutover(tx, builderId);
        await markExactReady(tx, builderId);
        const readiness = await readCutover(tx, builderId);
        const rule = await insertRule(tx, builderId, 'day');
        const originOrder = await ruleAuthorityOrder(tx, builderId, rule.id);
        expect(BigInt(originOrder)).toBeGreaterThan(BigInt(readiness.ready_order!));
        const period = await currentPeriod(tx, 'day');
        expect(Date.parse(period.start)).toBeLessThan(Date.parse(cutoverAt));
        accountId = await insertAccount(tx, builderId, rule, period, '0');
        await insertOpeningEvidence(
          tx,
          builderId,
          accountId,
          rule,
          period,
          'post_cutover_zero',
          cutoverAt,
          '0',
        );
      });

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            UPDATE public.budget_account_opening_evidence
            SET opening_committed_usd = 1
            WHERE builder_id = ${builderId} AND account_id = ${accountId}
          `;
        }),
        '55000',
        /append-only/,
      );
      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            DELETE FROM public.budget_account_opening_evidence
            WHERE builder_id = ${builderId} AND account_id = ${accountId}
          `;
        }),
        '55000',
        /append-only/,
      );

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          const rule = await insertRule(tx, builderId, 'hour');
          const period = await currentPeriod(tx, 'hour');
          await insertAccount(tx, builderId, rule, period, '0');
        }),
        '23514',
        /every budget account requires exactly one opening-evidence row/,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'accepts exact nonzero backfill only for a straddling pre-cutover rule and rejects fabricated zero evidence',
    async () => {
      const builderId = await insertBuilder(db(), 'exact-opening');
      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          const exactRule = await insertRule(tx, builderId, 'day');
          const zeroRule = await insertRule(tx, builderId, 'hour');
          const cutoverAt = await createExactCutover(tx, builderId);
          await markExactReady(tx, builderId);

          const readiness = await readCutover(tx, builderId);
          const zeroRuleOrder = await ruleAuthorityOrder(tx, builderId, zeroRule.id);
          expect(BigInt(zeroRuleOrder)).toBeLessThan(BigInt(readiness.ready_order!));

          const exactPeriod = await currentPeriod(tx, 'day');
          const exactAccount = await insertAccount(tx, builderId, exactRule, exactPeriod, '3.25');
          await insertOpeningEvidence(
            tx,
            builderId,
            exactAccount,
            exactRule,
            exactPeriod,
            'exact_backfill',
            cutoverAt,
            '3.25',
          );

          const zeroPeriod = await currentPeriod(tx, 'hour');
          const zeroAccount = await insertAccount(tx, builderId, zeroRule, zeroPeriod, '0');
          await insertOpeningEvidence(
            tx,
            builderId,
            zeroAccount,
            zeroRule,
            zeroPeriod,
            'post_cutover_zero',
            cutoverAt,
            '0',
          );
        }),
        '23514',
        /post-cutover accounts require an explicit zero opening at or after cutover/,
      );

      // Prove the valid exact evidence independently of the deliberately
      // aborted mixed transaction above.
      const validBuilderId = await insertBuilder(db(), 'exact-opening-valid');
      await db().begin(async (tx) => {
        await useBuilder(tx, validBuilderId);
        const rule = await insertRule(tx, validBuilderId, 'day');
        const cutoverAt = await createExactCutover(tx, validBuilderId);
        await markExactReady(tx, validBuilderId);
        const period = await currentPeriod(tx, 'day');
        const accountId = await insertAccount(tx, validBuilderId, rule, period, '3.25');
        await insertOpeningEvidence(
          tx,
          validBuilderId,
          accountId,
          rule,
          period,
          'exact_backfill',
          cutoverAt,
          '3.25',
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'requires exact backfill for a stable rule created while the cutover is pending',
    async () => {
      const builderId = await insertBuilder(db(), 'pending-rule');
      let cutoverAt = '';
      let rule: RuleFixture | undefined;
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        cutoverAt = await createExactCutover(tx, builderId);
      });
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        rule = await insertRule(tx, builderId, 'day');
      });
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await markExactReady(tx, builderId);
        const readiness = await readCutover(tx, builderId);
        const originOrder = await ruleAuthorityOrder(tx, builderId, rule!.id);
        expect(BigInt(originOrder)).toBeLessThan(BigInt(readiness.ready_order!));
      });

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          const period = await currentPeriod(tx, 'day');
          const accountId = await insertAccount(tx, builderId, rule!, period, '0');
          await insertOpeningEvidence(
            tx,
            builderId,
            accountId,
            rule!,
            period,
            'post_cutover_zero',
            cutoverAt,
            '0',
          );
        }),
        '23514',
        /post-cutover accounts require an explicit zero opening at or after cutover/,
      );

      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        const period = await currentPeriod(tx, 'day');
        const accountId = await insertAccount(tx, builderId, rule!, period, '1.5');
        await insertOpeningEvidence(
          tx,
          builderId,
          accountId,
          rule!,
          period,
          'exact_backfill',
          cutoverAt,
          '1.5',
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'uses stable revision-zero order when a pre-ready rule rotates before first materialization',
    async () => {
      const builderId = await insertBuilder(db(), 'rotated-origin');
      let cutoverAt = '';
      let origin: RuleFixture | undefined;
      let readyOrder = '';
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        origin = await insertRule(tx, builderId, 'day');
        cutoverAt = await createExactCutover(tx, builderId);
        await markExactReady(tx, builderId);
        readyOrder = (await readCutover(tx, builderId)).ready_order!;
      });

      let successor: RuleFixture | undefined;
      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        successor = await rotateRule(tx, builderId, origin!);
        expect(BigInt(await ruleAuthorityOrder(tx, builderId, origin!.id))).toBeLessThan(
          BigInt(readyOrder),
        );
        expect(BigInt(await ruleAuthorityOrder(tx, builderId, successor.id))).toBeGreaterThan(
          BigInt(readyOrder),
        );
      });

      await expectPgError(
        db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          const period = await currentPeriod(tx, 'day');
          const accountId = await insertAccount(tx, builderId, successor!, period, '0');
          await insertOpeningEvidence(
            tx,
            builderId,
            accountId,
            successor!,
            period,
            'post_cutover_zero',
            cutoverAt,
            '0',
          );
        }),
        '23514',
        /post-cutover accounts require an explicit zero opening at or after cutover/,
      );

      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        const period = await currentPeriod(tx, 'day');
        const accountId = await insertAccount(tx, builderId, successor!, period, '2');
        await insertOpeningEvidence(
          tx,
          builderId,
          accountId,
          successor!,
          period,
          'exact_backfill',
          cutoverAt,
          '2',
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'forces tenant RLS on both new authorities and denies cross-tenant reads and writes',
    async () => {
      await ensureRlsTestRole(db());
      await db().unsafe(
        `REVOKE ALL ON SEQUENCE public.pylva_budget_authority_order_seq FROM ${RLS_TEST_USER};
GRANT USAGE ON SEQUENCE public.pylva_budget_authority_order_seq TO ${RLS_TEST_USER};`,
      );
      const builderA = await insertBuilder(db(), 'rls-a');
      const builderB = await insertBuilder(db(), 'rls-b');
      await db().begin(async (tx) => {
        await useBuilder(tx, builderA);
        await tx`
          INSERT INTO public.budget_control_cutovers (builder_id, mode)
          VALUES (${builderA}, 'exact_backfill')
        `;
      });

      const tenantSql = postgres(rlsDatabaseUrl(scratch!.url), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await tenantSql`SELECT set_config('app.builder_id', ${builderA}, false)`;
        const [sequencePrivilege] = await tenantSql<
          { update_value: boolean; usage_value: boolean }[]
        >`
          SELECT has_sequence_privilege(
            current_user,
            'public.pylva_budget_authority_order_seq',
            'USAGE'
          ) AS usage_value,
          has_sequence_privilege(
            current_user,
            'public.pylva_budget_authority_order_seq',
            'UPDATE'
          ) AS update_value
        `;
        expect(sequencePrivilege).toEqual({ update_value: false, usage_value: true });
        const tenantRule = await insertRule(tenantSql, builderA, 'day');
        expect(
          BigInt(await ruleAuthorityOrder(tenantSql, builderA, tenantRule.id)),
        ).toBeGreaterThan(0n);

        const rows = await tenantSql<{ builder_id: string }[]>`
          SELECT builder_id::TEXT AS builder_id
          FROM public.budget_control_cutovers
          ORDER BY builder_id
        `;
        expect(rows.map((row) => row.builder_id)).toEqual([builderA]);

        await expectPgError(
          tenantSql`
            INSERT INTO public.budget_control_cutovers (builder_id, mode)
            VALUES (${builderB}, 'exact_backfill')
          `,
          '42501',
          /tenant context|row-level security policy/,
        );

        const rlsState = await db()<{ forced: boolean; table_name: string; enabled: boolean }[]>`
          SELECT c.relname AS table_name,
                 c.relrowsecurity AS enabled,
                 c.relforcerowsecurity AS forced
          FROM pg_class c
          WHERE c.oid IN (
            'public.budget_control_cutovers'::regclass,
            'public.budget_account_opening_evidence'::regclass
          )
          ORDER BY c.relname
        `;
        expect(rlsState).toEqual([
          { enabled: true, forced: true, table_name: 'budget_account_opening_evidence' },
          { enabled: true, forced: true, table_name: 'budget_control_cutovers' },
        ]);
      } finally {
        await tenantSql.end();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
