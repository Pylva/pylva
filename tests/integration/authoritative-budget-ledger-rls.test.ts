import crypto from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';
import { ensureRlsTestRole, rlsDatabaseUrl } from '../helpers/rls-test-role.js';

const MIGRATION_FILENAME = '050_authoritative_budget_control_ledger.sql';
const LEDGER_TABLES = [
  'budget_accounts',
  'budget_rule_revisions',
  'budget_reservations',
  'budget_reservation_allocations',
  'budget_reservation_transitions',
  'budget_usage_ledger',
  'budget_cost_event_outbox',
] as const;

const TIMESTAMP_PLACEHOLDER = '1970-01-01T00:00:00.000Z';
const HISTORICAL_PERIOD_START = '2020-01-01T00:00:00.000Z';
const HISTORICAL_PERIOD_END = '2020-01-02T00:00:00.000Z';
const HISTORICAL_RESERVED_AT = '2020-01-01T00:01:00.000Z';
const HISTORICAL_EXPIRES_AT = '2020-01-01T00:06:00.000Z';
const HISTORICAL_COMMITTED_AT = '2020-01-01T00:02:00.000Z';
const HISTORICAL_RETAIN_UNTIL = '2020-01-03T00:02:00.000Z';

interface TenantLedgerFixture {
  accountId: string;
  allocationId: string;
  costEventId: string;
  decisionId: string;
  operationId: string;
  outboxId: string;
  reservationId: string;
  ruleKey: string;
  ruleRevisionId: string;
  transitionId: string;
  usageId: string;
}

let scratch: ScratchDb | undefined;
let tenantSql: ReturnType<typeof postgres> | undefined;
let builderAId = '';
let builderBId = '';
let builderALedger: TenantLedgerFixture | undefined;
let builderBLedger: TenantLedgerFixture | undefined;

function ledger(table: (typeof LEDGER_TABLES)[number]): string {
  return `"${table}"`;
}

function fixtureA(): TenantLedgerFixture {
  if (!builderALedger) throw new Error('builder A ledger fixture is not ready');
  return builderALedger;
}

function fixtureB(): TenantLedgerFixture {
  if (!builderBLedger) throw new Error('builder B ledger fixture is not ready');
  return builderBLedger;
}

function owner(): ScratchDb['sql'] {
  if (!scratch) throw new Error('authoritative budget ledger RLS scratch database is not ready');
  return scratch.sql;
}

function tenant(): ReturnType<typeof postgres> {
  if (!tenantSql) throw new Error('non-owner RLS connection is not ready');
  return tenantSql;
}

async function seedTenantLedger(
  sql: ScratchDb['sql'],
  builderId: string,
  ruleKey: string,
): Promise<TenantLedgerFixture> {
  const fixture: TenantLedgerFixture = {
    accountId: crypto.randomUUID(),
    allocationId: crypto.randomUUID(),
    costEventId: crypto.randomUUID(),
    decisionId: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    outboxId: crypto.randomUUID(),
    reservationId: crypto.randomUUID(),
    ruleKey,
    ruleRevisionId: crypto.randomUUID(),
    transitionId: crypto.randomUUID(),
    usageId: crypto.randomUUID(),
  };
  const traceId = crypto.randomUUID();
  const spanId = crypto.randomUUID();
  const pricingSnapshot = { provider: 'openai', model: 'gpt-4o-mini' };
  const requestSnapshot = {
    schema_version: '1.0',
    mode: 'enforce',
    operation_id: fixture.operationId,
    customer_id: 'customer_1',
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: null,
    step_name: 'agent.call',
    framework: 'none',
    reservation_ttl_seconds: 300,
    kind: 'llm',
    provider: 'openai',
    model: 'gpt-4o-mini',
    estimated_input_tokens: 100,
    max_output_tokens: 50,
  };
  const reserveResponseSnapshot = {
    schema_version: '1.0',
    decision: 'reserved',
    allowed: true,
    decision_id: fixture.decisionId,
    operation_id: fixture.operationId,
    reservation_id: fixture.reservationId,
    state: 'reserved',
    reserved_usd: '1',
    remaining_usd: '9.5',
    expires_at: TIMESTAMP_PLACEHOLDER,
    warnings: [],
  };
  const usageSnapshot = {
    schema_version: '1.0',
    status: 'success',
    latency_ms: 250,
    stream_aborted: false,
    kind: 'llm',
    actual_input_tokens: 100,
    actual_output_tokens: 50,
  };
  const commitResponseSnapshot = {
    schema_version: '1.0',
    state: 'committed',
    reservation_id: fixture.reservationId,
    operation_id: fixture.operationId,
    reserved_usd: '1',
    actual_usd: '0.75',
    released_usd: '0.25',
    overage_usd: '0',
    budget_exceeded_after_commit: false,
    committed_at: TIMESTAMP_PLACEHOLDER,
    idempotent_replay: false,
    late: false,
  };

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.builder_id', ${builderId}, true)`;
    const [period] = await tx<{ period_end: string; period_start: string }[]>`
      SELECT
        pylva_budget_timestamp_text(
          date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC')
            AT TIME ZONE 'UTC'
        ) AS period_start,
        pylva_budget_timestamp_text(
          (
            date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC')
              + INTERVAL '1 day'
          ) AT TIME ZONE 'UTC'
        ) AS period_end
    `;
    if (!period) throw new Error('unable to derive the canonical UTC account period');
    const ruleSnapshot = {
      schema_version: '1.0',
      rule_key: fixture.ruleKey,
      scope: 'pooled',
      subject_customer_id: null,
      period: 'day',
      period_start: period.period_start,
      period_end: period.period_end,
      enforcement: 'hard_stop',
      limit_usd: '10.5',
      opening_committed_usd: '0',
    };
    const configSnapshot = {
      schema_version: '1.0',
      rule_key: fixture.ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'hard_stop',
      limit_usd: '10.5',
    };
    await tx`
      INSERT INTO budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      )
      VALUES (
        ${builderId}, ${fixture.ruleRevisionId}, ${fixture.ruleKey}, 0, 'pooled', NULL,
        'day', 'hard_stop', '10.5', ${tx.json(configSnapshot)},
        pylva_budget_jsonb_sha256(${tx.json(configSnapshot)})
      )
    `;
    await tx`
      INSERT INTO budget_accounts (
        builder_id, id, rule_key, enforcement, limit_usd, scope,
        subject_customer_id, period, period_start, period_end,
        initial_rule_revision_id, initial_rule_snapshot, initial_rule_snapshot_hash,
        opening_committed_usd, committed_usd, reserved_usd, unresolved_usd
      )
      VALUES (
        ${builderId}, ${fixture.accountId}, ${fixture.ruleKey}, 'hard_stop', '10.5', 'pooled',
        NULL, 'day', ${period.period_start}, ${period.period_end}, ${fixture.ruleRevisionId},
        ${tx.json(ruleSnapshot)}, pylva_budget_jsonb_sha256(${tx.json(ruleSnapshot)}),
        '0', '0', '0', '0'
      )
    `;
    await tx`
      INSERT INTO budget_reservations (
        builder_id, decision_id, reservation_id, operation_id, schema_version,
        request_hash, request_snapshot, mode, kind, customer_id, trace_id, span_id,
        parent_span_id, step_name, framework, reservation_ttl_seconds,
        provider, model, estimated_input_tokens, max_output_tokens,
        decision, decision_reason, would_have_denied, state,
        pricing_snapshot, pricing_snapshot_hash,
        requested_usd, reserved_usd, actual_usd, released_usd, overage_usd,
        remaining_usd, deciding_account_id, reserve_response_snapshot
      )
      VALUES (
        ${builderId}, ${fixture.decisionId}, ${fixture.reservationId},
        ${fixture.operationId}, '1.0',
        pylva_budget_jsonb_sha256(${tx.json(requestSnapshot)}), ${tx.json(requestSnapshot)},
        'enforce', 'llm', 'customer_1', ${traceId}, ${spanId},
        NULL, 'agent.call', 'none', 300,
        'openai', 'gpt-4o-mini', 100, 50,
        'reserved', NULL, NULL, 'reserved',
        ${tx.json(pricingSnapshot)}, pylva_budget_jsonb_sha256(${tx.json(pricingSnapshot)}),
        '1', '1', '0', '0', '0', '9.5', NULL, ${tx.json(reserveResponseSnapshot)}
      )
    `;
    await tx`
      INSERT INTO budget_reservation_allocations (
        builder_id, id, reservation_decision_id, account_id, rule_key, rule_revision_id,
        rule_snapshot, rule_snapshot_hash, enforcement, evaluation_order,
        is_deciding, account_version_before, held_at_reserve, status,
        committed_before_usd, reserved_before_usd, unresolved_before_usd,
        requested_usd, projected_usd, limit_usd, remaining_usd,
        authorized_usd, actual_usd, released_usd, unresolved_usd, overage_usd
      )
      VALUES (
        ${builderId}, ${fixture.allocationId}, ${fixture.decisionId},
        ${fixture.accountId}, ${fixture.ruleKey}, ${fixture.ruleRevisionId},
        ${tx.json(ruleSnapshot)},
        pylva_budget_jsonb_sha256(${tx.json(ruleSnapshot)}), 'hard_stop', 0,
        false, 0, true, 'reserved', '0', '0', '0', '1', '1', '10.5', '9.5',
        '1', '0', '0', '0', '0'
      )
    `;
    await tx`
      UPDATE budget_reservations
      SET state = 'committed', actual_usd = '0.75', released_usd = '0.25',
          overage_usd = '0', committed_at = transaction_timestamp(),
          state_version = state_version + 1, updated_at = transaction_timestamp()
      WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_allocations
      SET status = 'committed', actual_usd = '0.75', released_usd = '0.25',
          unresolved_usd = '0', overage_usd = '0', updated_at = transaction_timestamp()
      WHERE builder_id = ${builderId} AND id = ${fixture.allocationId}
    `;
    await tx`
      INSERT INTO budget_reservation_transitions (
        builder_id, id, reservation_decision_id, type, extension_id,
        release_reason, request_hash, request_snapshot, response_snapshot,
        from_state, to_state, from_state_version, to_state_version,
        from_expires_at, to_expires_at, extend_by_seconds, occurred_at
      )
      VALUES (
        ${builderId}, ${fixture.transitionId}, ${fixture.decisionId}, 'commit', NULL,
        NULL, pylva_budget_jsonb_sha256(${tx.json(usageSnapshot)}),
        ${tx.json(usageSnapshot)}, ${tx.json(commitResponseSnapshot)},
        'reserved', 'committed', 0, 1,
        (SELECT expires_at FROM budget_reservations
         WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}),
        (SELECT expires_at FROM budget_reservations
         WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}),
        NULL, DEFAULT
      )
    `;
    await tx`
      INSERT INTO budget_usage_ledger (
        builder_id, id, reservation_decision_id, operation_id, cost_event_id,
        customer_id, trace_id, span_id, parent_span_id, step_name, framework,
        sdk_version, sdk_language, kind, provider, model,
        actual_input_tokens, actual_output_tokens, status, latency_ms,
        stream_aborted, actual_cost_usd, pricing_snapshot, pricing_snapshot_hash,
        usage_snapshot, usage_snapshot_hash, cost_source, instrumentation_tier,
        is_demo, retention_days, billing_retention_days, metadata,
        committed_at, retain_until
      )
      VALUES (
        ${builderId}, ${fixture.usageId}, ${fixture.decisionId}, ${fixture.operationId},
        ${fixture.costEventId}, 'customer_1', ${traceId}, ${spanId}, NULL,
        'agent.call', 'none', '1.2.0', 'typescript', 'llm', 'openai',
        'gpt-4o-mini', 100, 50, 'success', 250, false, '0.75',
        ${tx.json(pricingSnapshot)}, pylva_budget_jsonb_sha256(${tx.json(pricingSnapshot)}),
        ${tx.json(usageSnapshot)}, pylva_budget_jsonb_sha256(${tx.json(usageSnapshot)}),
        'auto', 'sdk_wrapper', false, 1, 1, ${tx.json({})},
        (SELECT committed_at FROM budget_reservations
         WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}),
        (SELECT committed_at + INTERVAL '1 day' FROM budget_reservations
         WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId})
      )
    `;
    await tx`
      INSERT INTO budget_cost_event_outbox (
        builder_id, id, usage_ledger_id, cost_event_id,
        payload_schema_version, payload, payload_hash
      )
      SELECT
        ${builderId}, ${fixture.outboxId}, id, cost_event_id, '1.6',
        pylva_budget_cost_event_payload(budget_usage_ledger),
        pylva_budget_jsonb_sha256(pylva_budget_cost_event_payload(budget_usage_ledger))
      FROM budget_usage_ledger
      WHERE builder_id = ${builderId} AND id = ${fixture.usageId}
    `;
  });

  return fixture;
}

/**
 * Retention is intentionally at least one day, while this suite must exercise
 * the real purge guards immediately. Move one otherwise-valid fixture into a
 * coherent historical window as the table owner, with user triggers disabled
 * only for this seed rewrite. CHECK and foreign-key constraints remain active,
 * and the authoritative closure functions are rerun before commit.
 */
async function makeRetentionEligible(
  sql: ScratchDb['sql'],
  builderId: string,
  fixture: TenantLedgerFixture,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.builder_id', ${builderId}, true)`;

    for (const table of LEDGER_TABLES) {
      await tx.unsafe(`ALTER TABLE ${ledger(table)} DISABLE TRIGGER USER`);
    }

    await tx`
      WITH replacement AS (
        SELECT
          initial_rule_snapshot || jsonb_build_object(
            'period_start', ${HISTORICAL_PERIOD_START}::text,
            'period_end', ${HISTORICAL_PERIOD_END}::text
          ) AS snapshot
        FROM budget_accounts
        WHERE builder_id = ${builderId} AND id = ${fixture.accountId}
      )
      UPDATE budget_accounts
      SET period_start = ${HISTORICAL_PERIOD_START},
          period_end = ${HISTORICAL_PERIOD_END},
          initial_rule_snapshot = replacement.snapshot,
          initial_rule_snapshot_hash = pylva_budget_jsonb_sha256(replacement.snapshot)
      FROM replacement
      WHERE builder_id = ${builderId} AND id = ${fixture.accountId}
    `;
    await tx`
      UPDATE budget_reservation_allocations allocation
      SET rule_snapshot = account.initial_rule_snapshot,
          rule_snapshot_hash = account.initial_rule_snapshot_hash
      FROM budget_accounts account
      WHERE allocation.builder_id = ${builderId}
        AND allocation.id = ${fixture.allocationId}
        AND account.builder_id = allocation.builder_id
        AND account.id = allocation.account_id
    `;
    await tx`
      UPDATE budget_reservations
      SET created_at = ${HISTORICAL_PERIOD_START},
          reserved_at = ${HISTORICAL_RESERVED_AT},
          expires_at = ${HISTORICAL_EXPIRES_AT},
          committed_at = ${HISTORICAL_COMMITTED_AT},
          reserve_response_snapshot = jsonb_set(
            reserve_response_snapshot,
            '{expires_at}',
            to_jsonb(${HISTORICAL_EXPIRES_AT}::text),
            TRUE
          )
      WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_transitions
      SET from_expires_at = ${HISTORICAL_EXPIRES_AT},
          to_expires_at = ${HISTORICAL_EXPIRES_AT},
          occurred_at = ${HISTORICAL_COMMITTED_AT},
          response_snapshot = jsonb_set(
            response_snapshot,
            '{committed_at}',
            to_jsonb(${HISTORICAL_COMMITTED_AT}::text),
            TRUE
          )
      WHERE builder_id = ${builderId} AND id = ${fixture.transitionId}
    `;
    await tx`
      UPDATE budget_usage_ledger
      SET committed_at = ${HISTORICAL_COMMITTED_AT},
          retain_until = ${HISTORICAL_RETAIN_UNTIL}
      WHERE builder_id = ${builderId} AND id = ${fixture.usageId}
    `;
    await tx`
      UPDATE budget_cost_event_outbox outbox
      SET payload = pylva_budget_cost_event_payload(usage),
          payload_hash = pylva_budget_jsonb_sha256(
            pylva_budget_cost_event_payload(usage)
          )
      FROM budget_usage_ledger usage
      WHERE outbox.builder_id = ${builderId}
        AND outbox.id = ${fixture.outboxId}
        AND usage.builder_id = outbox.builder_id
        AND usage.id = outbox.usage_ledger_id
    `;

    for (const table of LEDGER_TABLES) {
      await tx.unsafe(`ALTER TABLE ${ledger(table)} ENABLE TRIGGER USER`);
    }

    await tx`
      SELECT pylva_budget_assert_reservation_allocations(
        ${builderId}, ${fixture.decisionId}, FALSE
      )
    `;
    await tx`
      SELECT pylva_budget_assert_reservation_transitions(
        ${builderId}, ${fixture.decisionId}
      )
    `;
    await tx`
      SELECT pylva_budget_assert_account_postings(
        ${builderId}, ${fixture.accountId}
      )
    `;
    await tx`
      SELECT pylva_budget_assert_retention_tombstone_pair(
        ${builderId}, ${fixture.usageId}
      )
    `;
    await tx`SET CONSTRAINTS ALL IMMEDIATE`;
  });
}

beforeAll(async () => {
  const candidate = await createScratchDb({ prefix: 'authoritative_budget_ledger_rls' });
  try {
    await applyMigrationsThrough(candidate, MIGRATION_FILENAME);
    await ensureRlsTestRole(candidate.sql);

    const suffix = crypto.randomBytes(6).toString('hex');
    const builders = await candidate.sql<{ id: string }[]>`
      INSERT INTO builders (email, name, tier, slug)
      VALUES
        (${`ledger-rls-a-${suffix}@example.com`}, 'Ledger RLS A', 'pro',
         ${`ledger-rls-a-${suffix}`}),
        (${`ledger-rls-b-${suffix}@example.com`}, 'Ledger RLS B', 'pro',
         ${`ledger-rls-b-${suffix}`})
      RETURNING id
    `;
    builderAId = builders[0]!.id;
    builderBId = builders[1]!.id;
    const sharedRuleKey = crypto.randomUUID();
    builderALedger = await seedTenantLedger(candidate.sql, builderAId, sharedRuleKey);
    builderBLedger = await seedTenantLedger(candidate.sql, builderBId, sharedRuleKey);
    await makeRetentionEligible(candidate.sql, builderAId, builderALedger);

    tenantSql = postgres(rlsDatabaseUrl(candidate.url), {
      max: 1,
      onnotice: () => undefined,
    });
    scratch = candidate;
  } catch (error) {
    await tenantSql?.end();
    await candidate.drop();
    throw error;
  }
});

afterAll(async () => {
  await tenantSql?.end();
  await scratch?.drop();
});

describe('authoritative budget-control ledger RLS', () => {
  it('enables and forces RLS with one exact read/write isolation policy on all seven tables', async () => {
    const tables = await owner()<
      { relforcerowsecurity: boolean; relrowsecurity: boolean; table_name: string }[]
    >`
      SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY(${LEDGER_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
    expect(tables).toHaveLength(LEDGER_TABLES.length);
    expect(tables.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const policies = await owner()<
      {
        command: string;
        policy_name: string;
        qual: string | null;
        table_name: string;
        with_check: string | null;
      }[]
    >`
      SELECT tablename AS table_name, policyname AS policy_name, cmd AS command, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(${LEDGER_TABLES as unknown as string[]})
      ORDER BY tablename, policyname
    `;
    expect(policies).toHaveLength(LEDGER_TABLES.length);
    for (const policy of policies) {
      expect(policy.policy_name).toBe(`${policy.table_name}_isolation`);
      expect(policy.command).toBe('ALL');
      expect(policy.qual).toBe(policy.with_check);
      expect(policy.qual).toContain("current_setting('app.builder_id'::text, true)");
      expect(policy.with_check).toContain("current_setting('app.builder_id'::text, true)");
      expect(policy.qual).toContain('builder_id');
      expect(policy.with_check).toContain('builder_id');
    }
  });

  it('applies FORCE RLS to the table owner as well as a genuine NOBYPASSRLS role', async () => {
    const [role] = await owner()<
      { rolbypassrls: boolean; rolcanlogin: boolean; rolsuper: boolean }[]
    >`
      SELECT rolcanlogin, rolbypassrls, rolsuper
      FROM pg_roles
      WHERE rolname = 'pylva_rls_test'
    `;
    expect(role).toEqual({ rolcanlogin: true, rolbypassrls: false, rolsuper: false });

    const ownerProbe = postgres(scratch!.url, { max: 1, onnotice: () => undefined });
    try {
      const [withoutContext] = await ownerProbe<
        { account_count: number; revision_count: number }[]
      >`
        SELECT
          (SELECT COUNT(*)::integer FROM budget_accounts) AS account_count,
          (SELECT COUNT(*)::integer FROM budget_rule_revisions) AS revision_count
      `;
      expect(withoutContext).toEqual({ account_count: 0, revision_count: 0 });

      await ownerProbe.begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        const accountRows = await tx<{ builder_id: string }[]>`
          SELECT builder_id FROM budget_accounts
        `;
        const revisionRows = await tx<{ builder_id: string }[]>`
          SELECT builder_id FROM budget_rule_revisions
        `;
        expect(accountRows).toEqual([{ builder_id: builderAId }]);
        expect(revisionRows).toEqual([{ builder_id: builderAId }]);
      });

      await tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        const accountRows = await tx<{ builder_id: string }[]>`
          SELECT builder_id FROM budget_accounts
        `;
        const revisionRows = await tx<{ builder_id: string }[]>`
          SELECT builder_id FROM budget_rule_revisions
        `;
        expect(accountRows).toEqual([{ builder_id: builderAId }]);
        expect(revisionRows).toEqual([{ builder_id: builderAId }]);
      });
    } finally {
      await ownerProbe.end();
    }
  });

  it('fails closed for missing, invalid, and wrong builder context', async () => {
    const freshTenant = postgres(rlsDatabaseUrl(scratch!.url), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const missing = await freshTenant`SELECT builder_id FROM budget_accounts`;
      expect(missing).toEqual([]);

      await expect(
        freshTenant.begin(async (tx) => {
          await tx`SELECT set_config('app.builder_id', 'not-a-uuid', true)`;
          await tx`SELECT builder_id FROM budget_accounts`;
        }),
      ).rejects.toThrow(/invalid input syntax for type uuid/i);

      await freshTenant.begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${crypto.randomUUID()}, true)`;
        for (const table of LEDGER_TABLES) {
          const rows = await tx.unsafe(`SELECT builder_id FROM ${ledger(table)}`);
          expect(rows, table).toEqual([]);
        }
      });
    } finally {
      await freshTenant.end();
    }
  });

  it('returns only the selected tenant from every ledger table', async () => {
    for (const [visibleBuilderId, hiddenBuilderId] of [
      [builderAId, builderBId],
      [builderBId, builderAId],
    ] as const) {
      await tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${visibleBuilderId}, true)`;
        for (const table of LEDGER_TABLES) {
          const rows = await tx.unsafe<{ builder_id: string }[]>(
            `SELECT builder_id FROM ${ledger(table)} ORDER BY builder_id`,
          );
          expect(rows.length, `${table} should expose its current tenant row`).toBeGreaterThan(0);
          expect(
            rows.every((row) => row.builder_id === visibleBuilderId),
            table,
          ).toBe(true);
          expect(
            rows.some((row) => row.builder_id === hiddenBuilderId),
            table,
          ).toBe(false);
        }
      });
    }
  });

  it('hides cross-tenant updates and deletes before immutable-row guards can observe them', async () => {
    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      for (const table of LEDGER_TABLES) {
        const update = await tx.unsafe(
          `UPDATE ${ledger(table)} SET builder_id = builder_id WHERE builder_id = $1`,
          [builderAId],
        );
        expect(update.count, `${table} cross-tenant UPDATE`).toBe(0);

        const deletion = await tx.unsafe(`DELETE FROM ${ledger(table)} WHERE builder_id = $1`, [
          builderAId,
        ]);
        expect(deletion.count, `${table} cross-tenant DELETE`).toBe(0);
      }
    });

    await owner().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      for (const table of LEDGER_TABLES) {
        const rows = await tx.unsafe<{ count: number }[]>(
          `SELECT COUNT(*)::integer AS count FROM ${ledger(table)}`,
        );
        expect(rows[0]!.count, `${table} owner verification`).toBeGreaterThan(0);
      }
    });
  });

  it('rejects a wrong-builder INSERT on every ledger table', async () => {
    for (const table of LEDGER_TABLES) {
      await expect(
        tenant().begin(async (tx) => {
          await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
          const tableName = ledger(table);
          await tx.unsafe(
            `
              INSERT INTO ${tableName}
              SELECT (
                jsonb_populate_record(
                  NULL::${tableName},
                  to_jsonb(source_row) || jsonb_build_object('builder_id', $1::text)
                )
              ).*
              FROM ${tableName} AS source_row
              WHERE source_row.builder_id = $2
              LIMIT 1
            `,
            [builderAId, builderBId],
          );
        }),
        `${table} cross-tenant INSERT`,
      ).rejects.toThrow(/row-level security|tenant context/i);
    }
  });

  it('isolates global revisions and rejects cross-tenant account and allocation revision references', async () => {
    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      const hiddenRevision = await tx`
        SELECT id
        FROM budget_rule_revisions
        WHERE builder_id = ${builderBId} AND id = ${fixtureB().ruleRevisionId}
      `;
      expect(hiddenRevision).toEqual([]);
    });

    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        await tx`
          WITH candidate AS (
            SELECT
              account.*,
              account.period_start + INTERVAL '1 day' AS next_period_start,
              account.period_end + INTERVAL '1 day' AS next_period_end,
              account.initial_rule_snapshot || jsonb_build_object(
                'period_start', pylva_budget_timestamp_text(
                  account.period_start + INTERVAL '1 day'
                ),
                'period_end', pylva_budget_timestamp_text(
                  account.period_end + INTERVAL '1 day'
                )
              ) AS next_rule_snapshot
            FROM budget_accounts account
            WHERE account.builder_id = ${builderAId}
              AND account.id = ${fixtureA().accountId}
          )
          INSERT INTO budget_accounts (
            builder_id, id, rule_key, enforcement, limit_usd, scope,
            subject_customer_id, period, period_start, period_end,
            initial_rule_revision_id, initial_rule_snapshot,
            initial_rule_snapshot_hash, opening_committed_usd, committed_usd,
            reserved_usd, unresolved_usd, version
          )
          SELECT
            builder_id, ${crypto.randomUUID()}, rule_key, enforcement, limit_usd, scope,
            subject_customer_id, period, next_period_start, next_period_end,
            ${fixtureB().ruleRevisionId}, next_rule_snapshot,
            pylva_budget_jsonb_sha256(next_rule_snapshot), opening_committed_usd,
            opening_committed_usd, 0, 0, 0
          FROM candidate
        `;
      }),
    ).rejects.toThrow(/active global rule revision|foreign key/i);

    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        const [account] = await tx<
          {
            committed_usd: string;
            initial_rule_snapshot: Record<string, postgres.JSONValue | undefined>;
            initial_rule_snapshot_hash: string;
            limit_usd: string;
            reserved_usd: string;
            unresolved_usd: string;
            version: string;
          }[]
        >`
          SELECT committed_usd::text, reserved_usd::text, unresolved_usd::text,
                 limit_usd::text, version::text, initial_rule_snapshot,
                 initial_rule_snapshot_hash
          FROM budget_accounts
          WHERE builder_id = ${builderAId} AND id = ${fixtureA().accountId}
        `;
        if (!account) throw new Error('builder A account is not visible to its tenant');
        const projectedUsd =
          Number(account.committed_usd) +
          Number(account.reserved_usd) +
          Number(account.unresolved_usd) +
          1;
        const remainingUsd = Math.max(Number(account.limit_usd) - projectedUsd, 0);

        await tx`
          INSERT INTO budget_reservation_allocations (
            builder_id, id, reservation_decision_id, account_id, rule_key,
            rule_revision_id, rule_snapshot, rule_snapshot_hash, enforcement,
            evaluation_order, is_deciding, account_version_before,
            held_at_reserve, status, committed_before_usd, reserved_before_usd,
            unresolved_before_usd, requested_usd, projected_usd, limit_usd,
            remaining_usd, authorized_usd, actual_usd, released_usd,
            unresolved_usd, overage_usd
          )
          VALUES (
            ${builderAId}, ${crypto.randomUUID()}, ${fixtureA().decisionId},
            ${fixtureA().accountId}, ${fixtureA().ruleKey}, ${fixtureB().ruleRevisionId},
            ${tx.json(account.initial_rule_snapshot)}, ${account.initial_rule_snapshot_hash},
            'hard_stop', 99, false, ${account.version}, false, 'not_held',
            ${account.committed_usd}, ${account.reserved_usd}, ${account.unresolved_usd},
            '1', ${projectedUsd}, ${account.limit_usd}, ${remainingUsd},
            '0', '0', '0', '0', '0'
          )
        `;
      }),
    ).rejects.toThrow(/rule revision|foreign key/i);
  });

  it('rejects cross-tenant allocation and deciding-account references', async () => {
    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        await tx`
          INSERT INTO budget_reservation_allocations (
            builder_id, id, reservation_decision_id, account_id, rule_key, rule_revision_id,
            rule_snapshot, rule_snapshot_hash, enforcement, evaluation_order,
            is_deciding, account_version_before, held_at_reserve, status,
            committed_before_usd, reserved_before_usd, unresolved_before_usd,
            requested_usd, projected_usd, limit_usd, remaining_usd,
            authorized_usd, actual_usd, released_usd, unresolved_usd, overage_usd
          )
          VALUES (
            ${builderAId}, ${crypto.randomUUID()}, ${fixtureB().decisionId},
            ${fixtureB().accountId}, ${fixtureB().ruleKey}, ${fixtureB().ruleRevisionId},
            ${tx.json({})},
            ${'0'.repeat(64)}, 'hard_stop', 0, false, 0, true, 'reserved',
            '0', '0', '0', '1', '1', '10', '9', '1', '0', '0', '0', '0'
          )
        `;
      }),
    ).rejects.toThrow(/no matching reservation|foreign key/i);

    const decisionId = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        await tx`
          INSERT INTO budget_reservations
          SELECT
            builder_id, ${decisionId}, ${reservationId}, ${operationId}, schema_version,
            request_hash, request_snapshot, mode, kind, customer_id, trace_id, span_id,
            parent_span_id, step_name, framework, reservation_ttl_seconds,
            provider, model, estimated_input_tokens, max_output_tokens,
            cost_source_slug, tool_name, metric, maximum_value,
            decision, decision_reason, would_have_denied, 'reserved',
            pricing_snapshot, pricing_snapshot_hash, requested_usd, reserved_usd,
            '0', '0', '0', remaining_usd,
            ${fixtureB().accountId}, reserve_response_snapshot,
            rule_revision_ids, rule_set_hash, 0,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, created_at, updated_at
          FROM budget_reservations
          WHERE builder_id = ${builderAId} AND decision_id = ${fixtureA().decisionId}
        `;
      }),
    ).rejects.toThrow(/foreign key|deciding/i);
  });

  it('rejects cross-tenant deferred child relationships', async () => {
    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        await tx`
          INSERT INTO budget_reservation_transitions (
            builder_id, id, reservation_decision_id, type, extension_id,
            release_reason, request_hash, request_snapshot, response_snapshot,
            from_state, to_state, from_state_version, to_state_version,
            from_expires_at, to_expires_at, extend_by_seconds, occurred_at
          )
          VALUES (
            ${builderAId}, ${crypto.randomUUID()}, ${fixtureB().decisionId},
            'commit', NULL, NULL, pylva_budget_jsonb_sha256(${tx.json({})}),
            ${tx.json({})}, ${tx.json({})}, 'unresolved', 'committed', 0, 1,
            ${HISTORICAL_EXPIRES_AT}, ${HISTORICAL_EXPIRES_AT}, NULL, DEFAULT
          )
        `;
      }),
    ).rejects.toThrow(/matching reservation|lifecycle must exist|foreign key/i);

    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        await tx`
          INSERT INTO budget_usage_ledger
          SELECT
            builder_id, ${crypto.randomUUID()}, ${fixtureB().decisionId},
            ${fixtureB().operationId}, ${crypto.randomUUID()}, customer_id,
            trace_id, span_id, parent_span_id, step_name, framework,
            sdk_version, sdk_language, kind, provider, model,
            actual_input_tokens, actual_output_tokens, cost_source_slug,
            tool_name, metric, actual_value, status, latency_ms, stream_aborted,
            actual_cost_usd, pricing_snapshot, pricing_snapshot_hash,
            usage_snapshot, usage_snapshot_hash, cost_source,
            instrumentation_tier, is_demo, retention_days,
            billing_retention_days, metadata, committed_at, retain_until,
            NULL, created_at
          FROM budget_usage_ledger
          WHERE builder_id = ${builderAId} AND id = ${fixtureA().usageId}
        `;
      }),
    ).rejects.toThrow(/matching reservation|already committed reservation|foreign key/i);

    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        const payload = { event_id: fixtureB().costEventId, builder_id: builderAId };
        await tx`
          INSERT INTO budget_cost_event_outbox (
            builder_id, id, usage_ledger_id, cost_event_id,
            payload_schema_version, payload, payload_hash
          )
          VALUES (
            ${builderAId}, ${crypto.randomUUID()}, ${fixtureB().usageId},
            ${fixtureB().costEventId}, '1.6', ${tx.json(payload)},
            pylva_budget_jsonb_sha256(${tx.json(payload)})
          )
        `;
      }),
    ).rejects.toThrow(/matching outbox row|authoritative usage|foreign key/i);
  });

  it('evaluates deferred guards under the tenant context present at constraint time', async () => {
    await expect(
      tenant().begin(async (tx) => {
        await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
        const result = await tx`
          UPDATE budget_cost_event_outbox
          SET updated_at = updated_at
          WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
        `;
        expect(result.count).toBe(1);
        await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      }),
    ).rejects.toThrow(/tenant context does not match/i);
  });

  it('isolates reconciliation verification and the atomic retention purge', async () => {
    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const verifyOther = await tx`
        UPDATE budget_cost_event_outbox
        SET projection_verified_at = statement_timestamp()
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
      `;
      const purgeOtherUsage = await tx`
        UPDATE budget_usage_ledger
        SET pricing_snapshot = NULL, usage_snapshot = NULL, metadata = NULL
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().usageId}
      `;
      const purgeOtherOutbox = await tx`
        UPDATE budget_cost_event_outbox
        SET payload = NULL
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
      `;
      expect(verifyOther.count).toBe(0);
      expect(purgeOtherUsage.count).toBe(0);
      expect(purgeOtherOutbox.count).toBe(0);
    });

    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`SELECT set_config('app.outbox_worker_id', 'rls-retention-test', true)`;
      await tx`
        UPDATE budget_cost_event_outbox
        SET status = 'processing', attempts = attempts + 1
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
      `;
      await tx`
        UPDATE budget_cost_event_outbox
        SET status = 'projected'
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
      `;
      await tx`
        UPDATE budget_cost_event_outbox
        SET projection_verified_at = statement_timestamp()
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
      `;
    });

    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      await tx`
        UPDATE budget_usage_ledger
        SET pricing_snapshot = NULL, usage_snapshot = NULL, metadata = NULL
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().usageId}
      `;
      await tx`
        UPDATE budget_cost_event_outbox
        SET payload = NULL
        WHERE builder_id = ${builderAId} AND id = ${fixtureA().outboxId}
      `;
    });

    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderAId}, true)`;
      const [usage] = await tx<
        {
          details_purged_at: string | null;
          metadata: unknown;
          pricing_snapshot: unknown;
          usage_snapshot: unknown;
        }[]
      >`
        SELECT details_purged_at, pricing_snapshot, usage_snapshot, metadata
        FROM budget_usage_ledger
        WHERE id = ${fixtureA().usageId}
      `;
      const [outbox] = await tx<
        { payload: unknown; payload_purged_at: string | null; status: string }[]
      >`
        SELECT payload, payload_purged_at, status
        FROM budget_cost_event_outbox
        WHERE id = ${fixtureA().outboxId}
      `;
      expect(usage).toMatchObject({
        pricing_snapshot: null,
        usage_snapshot: null,
        metadata: null,
      });
      expect(usage!.details_purged_at).not.toBeNull();
      expect(outbox).toMatchObject({ payload: null, status: 'projected' });
      expect(outbox!.payload_purged_at).toEqual(usage!.details_purged_at);
    });

    await tenant().begin(async (tx) => {
      await tx`SELECT set_config('app.builder_id', ${builderBId}, true)`;
      const hiddenUsage = await tx`
        SELECT id FROM budget_usage_ledger WHERE id = ${fixtureA().usageId}
      `;
      const hiddenOutbox = await tx`
        SELECT id FROM budget_cost_event_outbox WHERE id = ${fixtureA().outboxId}
      `;
      const [ownUsage] = await tx<{ details_purged_at: string | null }[]>`
        SELECT details_purged_at FROM budget_usage_ledger WHERE id = ${fixtureB().usageId}
      `;
      const [ownOutbox] = await tx<{ payload_purged_at: string | null }[]>`
        SELECT payload_purged_at FROM budget_cost_event_outbox WHERE id = ${fixtureB().outboxId}
      `;
      expect(hiddenUsage).toEqual([]);
      expect(hiddenOutbox).toEqual([]);
      expect(ownUsage!.details_purged_at).toBeNull();
      expect(ownOutbox!.payload_purged_at).toBeNull();
    });
  });
});
