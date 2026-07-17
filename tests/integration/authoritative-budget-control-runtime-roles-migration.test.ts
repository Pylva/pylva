import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  CommitUsageRequestSchema,
  ReserveUsageRequestSchema,
  type ParsedReserveUsageRequest,
} from '@pylva/shared';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBudgetProjectionPostgresStore,
  createBudgetProjectionWorkerId,
} from '../../src/lib/budget-projection/postgres.js';
import {
  createBudgetControlCutover,
  markBudgetControlReady,
} from '../../src/lib/budget-control/readiness.js';
import { attestBudgetControlRuntime } from '../../src/lib/budget-control/runtime-posture.js';
import { createBudgetLifecycleService } from '../../src/lib/budget-control/lifecycle-service.js';
import { createReserveBudgetUsage } from '../../src/lib/budget-control/reservation-service.js';
import {
  reconcileBudgetRuleRevisionInTransaction,
  withBudgetRuleRevisionMutation,
} from '../../src/lib/budget-control/rule-revisions.js';
import {
  pgJsonbParameterText,
  withBudgetBuilderTransaction,
} from '../../src/lib/budget-control/transaction.js';
import { toolPayload } from '../budget-projection/fixtures.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const BASE_DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const RUNTIME_ROLES_MIGRATION_FILENAME = '052_authoritative_budget_control_runtime_roles.sql';
const LEGACY_RLS_COMPATIBILITY_MIGRATION_FILENAME =
  '053_legacy_catalog_owner_rls_compatibility.sql';
const DISCOVERY_OWNER = 'pylva_budget_projection_discovery_owner';
const RUNTIME_ROLE = 'pylva_budget_control_runtime';
const DISCOVERY_FUNCTION = 'public.pylva_budget_projection_actionable_builders(uuid,integer)';
const EXPIRY_OWNER = 'pylva_budget_expiry_discovery_owner';
const EXPIRY_FUNCTION = 'public.pylva_budget_expiry_actionable_builders(uuid,integer)';
const BUILDER_IDS = {
  pending: '10000000-0000-4000-8000-000000000001',
  delayedPending: '10000000-0000-4000-8000-000000000002',
  expiredProcessing: '10000000-0000-4000-8000-000000000003',
  activeProcessing: '10000000-0000-4000-8000-000000000004',
  projectedUnverified: '10000000-0000-4000-8000-000000000005',
  projectedVerified: '10000000-0000-4000-8000-000000000006',
} as const;
const EXPECTED_ACTIONABLE = [
  BUILDER_IDS.pending,
  BUILDER_IDS.expiredProcessing,
  BUILDER_IDS.projectedUnverified,
] as const;
const EXPECTED_EXPIRY_ACTIONABLE = [BUILDER_IDS.pending, BUILDER_IDS.expiredProcessing] as const;
const SDK_IDENTITY = { sdkVersion: '1.2.0', sdkLanguage: 'typescript' as const };
const execFileAsync = promisify(execFile);

type DiscoverySql = Sql | TransactionSql;

let scratch: ScratchDb | undefined;
let callerSql: Sql | undefined;
let callerRole: string | undefined;
let callerPassword: string | undefined;

function db(): Sql {
  if (!scratch) throw new Error('projection discovery scratch database is unavailable');
  return scratch.sql;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function collectPlanNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((entry) => collectPlanNodes(entry));
  if (value === null || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const descendants = Object.values(record).flatMap((entry) => collectPlanNodes(entry));
  return typeof record['Node Type'] === 'string' ? [record, ...descendants] : descendants;
}

function roleDatabaseUrl(databaseUrl: string, role: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function useBuilder(transaction: TransactionSql, builderId: string): Promise<void> {
  await transaction`
    SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
  `;
}

async function insertBuilder(builderId: string, label: string): Promise<void> {
  await db().begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    await transaction`
      INSERT INTO public.builders (id, email, name, tier, slug)
      VALUES (
        ${builderId}::UUID,
        ${`${label}@projection-discovery.example`},
        ${label},
        'pro',
        ${`projection-discovery-${label}`}
      )
    `;
  });
}

async function seedPendingOutbox(builderId: string): Promise<string> {
  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const payload = toolPayload({
    builder_id: builderId,
    customer_id: `${builderId}:customer`,
    event_id: eventId,
    operation_id: crypto.randomUUID(),
    reservation_decision_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    trace_id: crypto.randomUUID(),
  });

  await db().begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    await transaction`
      INSERT INTO public.budget_cost_event_outbox (
        builder_id,
        id,
        usage_ledger_id,
        cost_event_id,
        payload_schema_version,
        payload,
        payload_hash
      )
      VALUES (
        ${builderId}::UUID,
        ${outboxId}::UUID,
        ${crypto.randomUUID()}::UUID,
        ${eventId}::UUID,
        '1.6',
        ${pgJsonbParameterText(payload as unknown as postgres.JSONValue)}::TEXT::JSONB,
        ${'0'.repeat(64)}
      )
    `;
  });
  return outboxId;
}

async function seedReservationFixture(
  transaction: TransactionSql,
  builderId: string,
  lifecycle: 'due' | 'future' | 'denied',
): Promise<void> {
  const now = Date.now();
  const isDenied = lifecycle === 'denied';
  const createdAt = new Date(now - 2 * 60 * 60_000).toISOString();
  const reservedAt = isDenied ? null : createdAt;
  const expiresAt =
    lifecycle === 'due'
      ? new Date(now - 60 * 60_000).toISOString()
      : lifecycle === 'future'
        ? new Date(now + 60 * 60_000).toISOString()
        : null;
  const refusedAt = isDenied ? new Date(now - 60 * 60_000).toISOString() : null;
  const request = { schema_version: '1.0' };
  const pricing = { schema_version: '1.0' };
  const response = { schema_version: '1.0' };

  await useBuilder(transaction, builderId);
  await transaction`
    INSERT INTO public.budget_reservations (
      builder_id, decision_id, reservation_id, operation_id, schema_version,
      request_hash, request_snapshot, mode, kind, customer_id, trace_id, span_id,
      parent_span_id, step_name, framework, reservation_ttl_seconds,
      provider, model, estimated_input_tokens, max_output_tokens,
      decision, decision_reason, would_have_denied, state,
      pricing_snapshot, pricing_snapshot_hash, requested_usd, reserved_usd,
      actual_usd, released_usd, overage_usd, remaining_usd,
      deciding_account_id, reserve_response_snapshot, rule_revision_ids,
      rule_set_hash, authorization_transaction_id, expires_at, reserved_at,
      refused_at, state_version, created_at, updated_at
    ) VALUES (
      ${builderId}::UUID,
      ${crypto.randomUUID()}::UUID,
      ${isDenied ? null : crypto.randomUUID()}::UUID,
      ${crypto.randomUUID()}::UUID,
      '1.0',
      public.pylva_budget_jsonb_sha256(
        ${pgJsonbParameterText(request)}::TEXT::JSONB
      ),
      ${pgJsonbParameterText(request)}::TEXT::JSONB,
      'enforce',
      'llm',
      'expiry_customer',
      ${crypto.randomUUID()}::UUID,
      ${crypto.randomUUID()}::UUID,
      NULL,
      'expiry.discovery',
      'none',
      300,
      'openai',
      'gpt-4o-mini',
      100,
      50,
      ${isDenied ? 'denied' : 'reserved'},
      ${isDenied ? 'budget_exceeded' : null},
      NULL,
      ${isDenied ? 'refused' : 'reserved'},
      ${pgJsonbParameterText(pricing)}::TEXT::JSONB,
      public.pylva_budget_jsonb_sha256(
        ${pgJsonbParameterText(pricing)}::TEXT::JSONB
      ),
      1,
      ${isDenied ? 0 : 1},
      0,
      0,
      0,
      24,
      NULL,
      ${pgJsonbParameterText(response)}::TEXT::JSONB,
      ARRAY[]::UUID[],
      public.pylva_budget_jsonb_sha256('[]'::JSONB),
      pg_catalog.txid_current(),
      ${expiresAt}::TIMESTAMPTZ,
      ${reservedAt}::TIMESTAMPTZ,
      ${refusedAt}::TIMESTAMPTZ,
      0,
      ${createdAt}::TIMESTAMPTZ,
      ${refusedAt ?? createdAt}::TIMESTAMPTZ
    )
  `;
}

async function discover(
  sql: DiscoverySql,
  afterBuilderId: string | null,
  limit: number | null,
): Promise<string[]> {
  const rows = await sql<{ builder_id: string }[]>`
    SELECT builder_id
    FROM public.pylva_budget_projection_actionable_builders(
      ${afterBuilderId}::UUID,
      ${limit}::INTEGER
    )
  `;
  return rows.map((row) => row.builder_id);
}

async function discoverExpiry(
  sql: DiscoverySql,
  afterBuilderId: string | null,
  limit: number | null,
): Promise<string[]> {
  const rows = await sql<{ builder_id: string }[]>`
    SELECT builder_id
    FROM public.pylva_budget_expiry_actionable_builders(
      ${afterBuilderId}::UUID,
      ${limit}::INTEGER
    )
  `;
  return rows.map((row) => row.builder_id);
}

function llmReserveRequest(): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: crypto.randomUUID(),
    customer_id: 'runtime_pricing_customer',
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'runtime.llm',
    kind: 'llm',
    provider: 'runtime-openai',
    model: 'runtime-gpt',
    estimated_input_tokens: 100,
    max_output_tokens: 50,
  });
}

function toolReserveRequest(): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: crypto.randomUUID(),
    customer_id: 'runtime_pricing_customer',
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'runtime.tool',
    kind: 'tool',
    cost_source_slug: 'runtime-search',
    tool_name: 'runtime_search',
    metric: 'credit',
    maximum_value: '2',
  });
}

async function stateFingerprint(
  relation: 'budget_cost_event_outbox' | 'budget_reservations',
): Promise<{ row_count: string; state_fingerprint: string }> {
  const tenantRows: unknown[] = [];
  for (const builderId of Object.values(BUILDER_IDS)) {
    const rows = await db().begin(async (transaction) => {
      await useBuilder(transaction, builderId);
      if (relation === 'budget_cost_event_outbox') {
        return transaction<
          Array<{
            builder_id: string;
            id: string;
            projection_verified_at: string | null;
            status: string;
          }>
        >`
          SELECT builder_id::TEXT AS builder_id,
                 id::TEXT AS id,
                 status,
                 projection_verified_at::TEXT AS projection_verified_at
          FROM public.budget_cost_event_outbox
          WHERE builder_id = ${builderId}::UUID
          ORDER BY id
        `;
      }
      return transaction<
        Array<{
          builder_id: string;
          decision: string;
          decision_id: string;
          expires_at: string | null;
          state: string;
        }>
      >`
        SELECT builder_id::TEXT AS builder_id,
               decision_id::TEXT AS decision_id,
               decision,
               state,
               expires_at::TEXT AS expires_at
        FROM public.budget_reservations
        WHERE builder_id = ${builderId}::UUID
        ORDER BY decision_id
      `;
    });
    tenantRows.push(...rows);
  }
  return {
    row_count: String(tenantRows.length),
    state_fingerprint: crypto.createHash('sha256').update(JSON.stringify(tenantRows)).digest('hex'),
  };
}

async function cleanup(): Promise<void> {
  await callerSql?.end().catch(() => undefined);
  callerSql = undefined;
  callerPassword = undefined;
  await scratch?.drop().catch(() => undefined);
  scratch = undefined;

  if (callerRole) {
    const admin = postgres(BASE_DATABASE_URL, { max: 1, onnotice: () => undefined });
    try {
      await admin.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(callerRole)}`);
    } finally {
      await admin.end();
      callerRole = undefined;
    }
  }
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'authoritative_projection_discovery' });
  try {
    // The production migration runner creates this ledger before applying any
    // numbered migration. Direct scratch helpers intentionally do not, so
    // reproduce the runner contract for the runtime ACL assertions below.
    await db().unsafe(`
      CREATE TABLE public.schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_time_ms INTEGER NOT NULL,
        applied_by TEXT NOT NULL
      )
    `);
    await db()`
      INSERT INTO public.schema_migrations (
        filename, checksum, execution_time_ms, applied_by
      )
      VALUES ('fixture.sql', 'fixture-checksum', 0, 'fixture')
    `;
    const [migrationPrincipal] = await db()<
      Array<{
        bypasses_rls: boolean;
        can_create_roles: boolean;
        is_superuser: boolean;
        role_name: string;
      }>
    >`
      SELECT role.rolname AS role_name,
             role.rolsuper AS is_superuser,
             role.rolcreaterole AS can_create_roles,
             role.rolbypassrls AS bypasses_rls
      FROM pg_catalog.pg_roles AS role
      WHERE role.rolname = CURRENT_USER
    `;
    expect(migrationPrincipal).toMatchObject({
      bypasses_rls: false,
      can_create_roles: true,
      is_superuser: false,
    });

    await applyMigrationsThrough(scratch, '051');
    const migrationSql = await fs.readFile(
      path.resolve('db/migrations', RUNTIME_ROLES_MIGRATION_FILENAME),
      'utf8',
    );
    expect(migrationSql).not.toContain('SESSION_USER');

    // CREATE OR REPLACE preserves the ACL of a function that already exists.
    // Seed hostile named and PUBLIC grants so the first 052 application proves
    // it seals legacy functions instead of assuming a pristine catalog.
    await db().unsafe(`
      CREATE FUNCTION public.pylva_budget_projection_actionable_builders(
        p_after_builder_id UUID DEFAULT NULL,
        p_limit INTEGER DEFAULT 250
      )
      RETURNS TABLE (builder_id UUID)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS 'SELECT NULL::UUID WHERE FALSE';

      CREATE FUNCTION public.pylva_budget_expiry_actionable_builders(
        p_after_builder_id UUID DEFAULT NULL,
        p_limit INTEGER DEFAULT 250
      )
      RETURNS TABLE (builder_id UUID)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog
      AS 'SELECT NULL::UUID WHERE FALSE';

      GRANT EXECUTE ON FUNCTION
        public.pylva_budget_projection_actionable_builders(UUID, INTEGER)
        TO pg_monitor;
      GRANT EXECUTE ON FUNCTION
        public.pylva_budget_expiry_actionable_builders(UUID, INTEGER)
        TO pg_monitor;
    `);
    const [legacyFunctionGrant] = await db()<Array<{ granted: boolean }>>`
      SELECT pg_catalog.has_function_privilege(
               'pg_monitor',
               ${DISCOVERY_FUNCTION}::REGPROCEDURE,
               'EXECUTE'
             )
             AND pg_catalog.has_function_privilege(
               'pg_monitor',
               ${EXPIRY_FUNCTION}::REGPROCEDURE,
               'EXECUTE'
             ) AS granted
    `;
    expect(legacyFunctionGrant?.granted).toBe(true);
    await db().begin((transaction) => transaction.unsafe(migrationSql));

    // Replay after function ownership has transferred and pin temporary
    // ownership membership to the effective migration role. Injected table,
    // column, sequence, and ambient PUBLIC schema drift must be removed too.
    await db().unsafe(`
      GRANT SELECT (id)
      ON TABLE public.api_keys
      TO ${RUNTIME_ROLE};
      GRANT SELECT (id)
      ON TABLE public.builders
      TO ${DISCOVERY_OWNER};
      GRANT SELECT
      ON TABLE public.customers
      TO ${EXPIRY_OWNER};
      GRANT UPDATE (id)
      ON TABLE public.customers
      TO ${EXPIRY_OWNER};
      GRANT USAGE
      ON SEQUENCE public.pylva_budget_authority_order_seq
      TO ${DISCOVERY_OWNER};
      GRANT CREATE
      ON SCHEMA public
      TO PUBLIC;
      GRANT SELECT
      ON TABLE public.api_keys
      TO PUBLIC;
      GRANT UPDATE (name)
      ON TABLE public.builders
      TO PUBLIC;
      GRANT USAGE
      ON SEQUENCE public.pylva_budget_authority_order_seq
      TO PUBLIC
    `);
    const [injectedAclDrift] = await db()<
      Array<{
        expiry_reads_customers: boolean;
        projection_creates_public: boolean;
        projection_reads_builder_id: boolean;
        projection_uses_sequence: boolean;
        public_reads_api_keys: boolean;
        public_updates_builder_name: boolean;
        public_uses_sequence: boolean;
        runtime_reads_api_key_id: boolean;
      }>
    >`
      SELECT pg_catalog.has_column_privilege(
               ${RUNTIME_ROLE},
               'public.api_keys',
               'id',
               'SELECT'
             ) AS runtime_reads_api_key_id,
             pg_catalog.has_column_privilege(
               ${DISCOVERY_OWNER},
               'public.builders',
               'id',
               'SELECT'
             ) AS projection_reads_builder_id,
             pg_catalog.has_table_privilege(
               ${EXPIRY_OWNER},
               'public.customers',
               'SELECT'
             ) AS expiry_reads_customers,
             pg_catalog.has_sequence_privilege(
               ${DISCOVERY_OWNER},
               'public.pylva_budget_authority_order_seq',
               'USAGE'
             ) AS projection_uses_sequence,
             pg_catalog.has_schema_privilege(
               ${DISCOVERY_OWNER},
               'public',
               'CREATE'
             ) AS projection_creates_public,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class AS relation
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 relation.relacl
               ) AS privilege
               WHERE relation.oid = 'public.api_keys'::REGCLASS
                 AND privilege.grantee = 0
                 AND privilege.privilege_type = 'SELECT'
             ) AS public_reads_api_keys,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_attribute AS attribute
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 attribute.attacl
               ) AS privilege
               WHERE attribute.attrelid = 'public.builders'::REGCLASS
                 AND attribute.attname = 'name'
                 AND privilege.grantee = 0
                 AND privilege.privilege_type = 'UPDATE'
             ) AS public_updates_builder_name,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_class AS sequence
               CROSS JOIN LATERAL pg_catalog.aclexplode(
                 sequence.relacl
               ) AS privilege
               WHERE sequence.oid =
                     'public.pylva_budget_authority_order_seq'::REGCLASS
                 AND privilege.grantee = 0
                 AND privilege.privilege_type = 'USAGE'
             ) AS public_uses_sequence
    `;
    expect(injectedAclDrift).toEqual({
      expiry_reads_customers: true,
      projection_creates_public: true,
      projection_reads_builder_id: true,
      projection_uses_sequence: true,
      public_reads_api_keys: true,
      public_updates_builder_name: true,
      public_uses_sequence: true,
      runtime_reads_api_key_id: true,
    });
    await db().begin((transaction) => transaction.unsafe(migrationSql));

    const compatibilityMigrationSql = await fs.readFile(
      path.resolve('db/migrations', LEGACY_RLS_COMPATIBILITY_MIGRATION_FILENAME),
      'utf8',
    );
    await db().begin((transaction) => transaction.unsafe(compatibilityMigrationSql));

    // Fixtures exercise only discovery state. The authoritative lifecycle and
    // retention graph is covered by its dedicated suites; relax those two
    // fixture relationships only in this disposable database.
    await db()`
      ALTER TABLE public.budget_cost_event_outbox
      DROP CONSTRAINT budget_cost_event_outbox_usage_fk
    `;
    await db()`
      ALTER TABLE public.budget_cost_event_outbox
      DISABLE TRIGGER budget_cost_event_outbox_retention_pair_guard
    `;

    await Promise.all([
      insertBuilder(BUILDER_IDS.pending, 'pending'),
      insertBuilder(BUILDER_IDS.delayedPending, 'delayed-pending'),
      insertBuilder(BUILDER_IDS.expiredProcessing, 'expired-processing'),
      insertBuilder(BUILDER_IDS.activeProcessing, 'active-processing'),
      insertBuilder(BUILDER_IDS.projectedUnverified, 'projected-unverified'),
      insertBuilder(BUILDER_IDS.projectedVerified, 'projected-verified'),
    ]);

    const [pendingOutbox, delayedOutbox, expiredOutbox] = await Promise.all([
      seedPendingOutbox(BUILDER_IDS.pending),
      seedPendingOutbox(BUILDER_IDS.delayedPending),
      seedPendingOutbox(BUILDER_IDS.expiredProcessing),
      seedPendingOutbox(BUILDER_IDS.activeProcessing),
      seedPendingOutbox(BUILDER_IDS.projectedUnverified),
      seedPendingOutbox(BUILDER_IDS.projectedVerified),
    ]);
    // A second row for the same tenant proves discovery de-duplicates UUIDs.
    await seedPendingOutbox(BUILDER_IDS.pending);

    const store = createBudgetProjectionPostgresStore(db());
    const [expiredLease] = await store.claim(
      BUILDER_IDS.expiredProcessing,
      createBudgetProjectionWorkerId(),
      1,
    );
    expect(expiredLease?.outbox_id).toBe(expiredOutbox);
    expect(
      await store.claim(BUILDER_IDS.activeProcessing, createBudgetProjectionWorkerId(), 1),
    ).toHaveLength(1);

    const [unverifiedLease] = await store.claim(
      BUILDER_IDS.projectedUnverified,
      createBudgetProjectionWorkerId(),
      1,
    );
    expect(await store.markProjected(unverifiedLease!)).toBe(true);

    const [verifiedLease] = await store.claim(
      BUILDER_IDS.projectedVerified,
      createBudgetProjectionWorkerId(),
      1,
    );
    expect(await store.markProjected(verifiedLease!)).toBe(true);
    const [verifiedItem] = await store.listReconciliationItems(
      BUILDER_IDS.projectedVerified,
      null,
      1,
    );
    expect(await store.markVerified(verifiedItem!)).toBe(true);

    // Move one retry into the future and one processing lease into the past.
    // The production transition trigger remains enabled in every non-fixture
    // database; disabling it here avoids wall-clock sleeps without weakening
    // the discovery function under test.
    await db().begin(async (transaction) => {
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        DISABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await useBuilder(transaction, BUILDER_IDS.delayedPending);
      await transaction`
        UPDATE public.budget_cost_event_outbox
        SET available_at = date_trunc(
          'milliseconds',
          statement_timestamp() + INTERVAL '1 hour'
        )
        WHERE builder_id = ${BUILDER_IDS.delayedPending}::UUID
          AND id = ${delayedOutbox}::UUID
      `;
      await useBuilder(transaction, BUILDER_IDS.expiredProcessing);
      await transaction`
        UPDATE public.budget_cost_event_outbox
        SET created_at = date_trunc(
              'milliseconds', statement_timestamp() - INTERVAL '3 minutes'
            ),
            available_at = date_trunc(
              'milliseconds', statement_timestamp() - INTERVAL '3 minutes'
            ),
            locked_at = date_trunc(
              'milliseconds', statement_timestamp() - INTERVAL '2 minutes'
            ),
            last_attempt_at = date_trunc(
              'milliseconds', statement_timestamp() - INTERVAL '2 minutes'
            ),
            lock_expires_at = date_trunc(
              'milliseconds', statement_timestamp() - INTERVAL '1 minute'
            ),
            updated_at = date_trunc(
              'milliseconds', statement_timestamp() - INTERVAL '1 minute'
            )
        WHERE builder_id = ${BUILDER_IDS.expiredProcessing}::UUID
          AND id = ${expiredOutbox}::UUID
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        ENABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
    });
    expect(pendingOutbox).toBeDefined();

    await db()`ALTER TABLE public.budget_reservations DISABLE TRIGGER USER`;
    try {
      await db().begin(async (transaction) => {
        await seedReservationFixture(transaction, BUILDER_IDS.pending, 'due');
        await seedReservationFixture(transaction, BUILDER_IDS.pending, 'due');
        await seedReservationFixture(transaction, BUILDER_IDS.expiredProcessing, 'due');
        await seedReservationFixture(transaction, BUILDER_IDS.delayedPending, 'future');
        await seedReservationFixture(transaction, BUILDER_IDS.activeProcessing, 'denied');
      });
    } finally {
      await db()`ALTER TABLE public.budget_reservations ENABLE TRIGGER USER`;
    }

    callerRole = `pylva_projection_caller_${crypto.randomBytes(6).toString('hex')}`;
    callerPassword = `projection-${crypto.randomBytes(18).toString('hex')}`;
    await db().unsafe(`
      CREATE ROLE ${quoteIdentifier(callerRole)}
        LOGIN
        PASSWORD ${sqlStringLiteral(callerPassword)}
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        INHERIT
        NOREPLICATION
        NOBYPASSRLS
    `);
    await db().unsafe(`GRANT ${RUNTIME_ROLE} TO ${quoteIdentifier(callerRole)}`);
    callerSql = postgres(roleDatabaseUrl(scratch.url, callerRole, callerPassword), {
      max: 8,
      onnotice: () => undefined,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
});

afterAll(async () => {
  await cleanup();
});

describe('authoritative budget-control runtime roles through migration 053', () => {
  it('pins non-login NOBYPASSRLS owners and closed runtime ACLs', async () => {
    const [contract] = await db()<
      Array<{
        caller_can_execute: boolean;
        caller_inherits: boolean;
        caller_is_runtime_member: boolean;
        caller_bypasses_rls: boolean;
        owner_membership_is_safe: boolean;
        owner_can_create: boolean;
        owner_can_login: boolean;
        owner_bypasses_rls: boolean;
        owner_creates_db: boolean;
        owner_creates_roles: boolean;
        owner_inherits: boolean;
        owner_is_superuser: boolean;
        owner_owns_function: boolean;
        owner_reads_payload: boolean;
        owner_reads_required_column: boolean;
        owner_reads_unrelated_table: boolean;
        owner_replicates: boolean;
        owner_uses_schema: boolean;
        public_can_execute: boolean;
        runtime_bypasses_rls: boolean;
        runtime_can_execute: boolean;
        runtime_can_login: boolean;
        runtime_creates_db: boolean;
        runtime_creates_roles: boolean;
        runtime_inherits: boolean;
        runtime_is_superuser: boolean;
        runtime_replicates: boolean;
        search_path: string[] | null;
        security_definer: boolean;
        unexpected_execute_grant: boolean;
        volatility: string;
      }>
    >`
      SELECT owner.rolcanlogin AS owner_can_login,
             owner.rolsuper AS owner_is_superuser,
             owner.rolcreatedb AS owner_creates_db,
             owner.rolcreaterole AS owner_creates_roles,
             owner.rolinherit AS owner_inherits,
             owner.rolreplication AS owner_replicates,
             owner.rolbypassrls AS owner_bypasses_rls,
             runtime.rolcanlogin AS runtime_can_login,
             runtime.rolsuper AS runtime_is_superuser,
             runtime.rolcreatedb AS runtime_creates_db,
             runtime.rolcreaterole AS runtime_creates_roles,
             runtime.rolinherit AS runtime_inherits,
             runtime.rolreplication AS runtime_replicates,
             runtime.rolbypassrls AS runtime_bypasses_rls,
             caller.rolinherit AS caller_inherits,
             caller.rolbypassrls AS caller_bypasses_rls,
             function.prosecdef AS security_definer,
             function.provolatile AS volatility,
             function.proconfig AS search_path,
             function.proowner = owner.oid AS owner_owns_function,
             pg_catalog.has_schema_privilege(
               owner.oid, 'public', 'USAGE'
             ) AS owner_uses_schema,
             pg_catalog.has_schema_privilege(
               owner.oid, 'public', 'CREATE'
             ) AS owner_can_create,
             pg_catalog.has_column_privilege(
               owner.oid,
               'public.budget_cost_event_outbox',
               'builder_id',
               'SELECT'
             ) AS owner_reads_required_column,
             pg_catalog.has_column_privilege(
               owner.oid,
               'public.budget_cost_event_outbox',
               'payload',
               'SELECT'
             ) AS owner_reads_payload,
             pg_catalog.has_table_privilege(
               owner.oid,
               'public.builders',
               'SELECT'
             ) AS owner_reads_unrelated_table,
             (
               SELECT COUNT(*) = 1
                  AND pg_catalog.bool_and(
                    member.rolname = CURRENT_USER
                    AND member.rolcreaterole
                    AND NOT member.rolsuper
                    AND NOT member.rolbypassrls
                    AND membership.admin_option
                    AND NOT membership.inherit_option
                    AND NOT membership.set_option
                  )
               FROM pg_catalog.pg_auth_members AS membership
               JOIN pg_catalog.pg_roles AS member
                 ON member.oid = membership.member
               WHERE membership.roleid = owner.oid
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
               WHERE membership.member = owner.oid
             ) AS owner_membership_is_safe,
             EXISTS (
               SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
               WHERE membership.roleid = runtime.oid
                 AND membership.member = caller.oid
             ) AS caller_is_runtime_member,
             pg_catalog.has_function_privilege(
               runtime.oid, function.oid, 'EXECUTE'
             ) AS runtime_can_execute,
             pg_catalog.has_function_privilege(
               caller.oid, function.oid, 'EXECUTE'
             ) AS caller_can_execute,
             EXISTS (
               SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   function.proacl,
                   pg_catalog.acldefault('f', function.proowner)
                 )
               ) AS privilege
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS public_can_execute,
             EXISTS (
               SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   function.proacl,
                   pg_catalog.acldefault('f', function.proowner)
                 )
               ) AS privilege
               WHERE privilege.privilege_type = 'EXECUTE'
                 AND privilege.grantee NOT IN (owner.oid, runtime.oid)
             ) AS unexpected_execute_grant
      FROM pg_catalog.pg_roles AS owner
      JOIN pg_catalog.pg_roles AS runtime
        ON runtime.rolname = ${RUNTIME_ROLE}
      JOIN pg_catalog.pg_roles AS caller
        ON caller.rolname = ${callerRole!}
      CROSS JOIN pg_catalog.pg_proc AS function
      WHERE owner.rolname = ${DISCOVERY_OWNER}
        AND function.oid = ${DISCOVERY_FUNCTION}::REGPROCEDURE
    `;
    expect(contract).toEqual({
      caller_can_execute: true,
      caller_inherits: true,
      caller_is_runtime_member: true,
      caller_bypasses_rls: false,
      owner_membership_is_safe: true,
      owner_bypasses_rls: false,
      owner_can_create: false,
      owner_can_login: false,
      owner_creates_db: false,
      owner_creates_roles: false,
      owner_inherits: false,
      owner_is_superuser: false,
      owner_owns_function: true,
      owner_reads_payload: false,
      owner_reads_required_column: true,
      owner_reads_unrelated_table: false,
      owner_replicates: false,
      owner_uses_schema: true,
      public_can_execute: false,
      runtime_bypasses_rls: false,
      runtime_can_execute: true,
      runtime_can_login: false,
      runtime_creates_db: false,
      runtime_creates_roles: false,
      runtime_inherits: false,
      runtime_is_superuser: false,
      runtime_replicates: false,
      search_path: ['search_path=pg_catalog'],
      security_definer: true,
      unexpected_execute_grant: false,
      volatility: 's',
    });

    const columnGrants = await db()<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = 'budget_cost_event_outbox'
        AND grantee = ${DISCOVERY_OWNER}
        AND privilege_type = 'SELECT'
      ORDER BY column_name
    `;
    expect(columnGrants.map((row) => row.column_name)).toEqual([
      'attempts',
      'available_at',
      'builder_id',
      'lock_expires_at',
      'projection_verified_at',
      'status',
    ]);

    const [expiryContract] = await db()<
      Array<{
        caller_can_execute: boolean;
        owner_bypasses_rls: boolean;
        owner_can_create: boolean;
        owner_can_login: boolean;
        owner_creates_db: boolean;
        owner_creates_roles: boolean;
        owner_membership_is_safe: boolean;
        owner_inherits: boolean;
        owner_is_superuser: boolean;
        owner_owns_function: boolean;
        owner_reads_payload: boolean;
        owner_reads_required_column: boolean;
        owner_replicates: boolean;
        public_can_execute: boolean;
        runtime_can_execute: boolean;
        search_path: string[] | null;
        security_definer: boolean;
        unexpected_execute_grant: boolean;
      }>
    >`
      SELECT owner.rolcanlogin AS owner_can_login,
             owner.rolsuper AS owner_is_superuser,
             owner.rolcreatedb AS owner_creates_db,
             owner.rolcreaterole AS owner_creates_roles,
             owner.rolinherit AS owner_inherits,
             owner.rolreplication AS owner_replicates,
             owner.rolbypassrls AS owner_bypasses_rls,
             function.prosecdef AS security_definer,
             function.proconfig AS search_path,
             function.proowner = owner.oid AS owner_owns_function,
             pg_catalog.has_schema_privilege(
               owner.oid, 'public', 'CREATE'
             ) AS owner_can_create,
             pg_catalog.has_column_privilege(
               owner.oid,
               'public.budget_reservations',
               'builder_id',
               'SELECT'
             ) AS owner_reads_required_column,
             pg_catalog.has_column_privilege(
               owner.oid,
               'public.budget_reservations',
               'request_snapshot',
               'SELECT'
             ) AS owner_reads_payload,
             (
               SELECT COUNT(*) = 1
                  AND pg_catalog.bool_and(
                    member.rolname = CURRENT_USER
                    AND member.rolcreaterole
                    AND NOT member.rolsuper
                    AND NOT member.rolbypassrls
                    AND membership.admin_option
                    AND NOT membership.inherit_option
                    AND NOT membership.set_option
                  )
               FROM pg_catalog.pg_auth_members AS membership
               JOIN pg_catalog.pg_roles AS member
                 ON member.oid = membership.member
               WHERE membership.roleid = owner.oid
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
               WHERE membership.member = owner.oid
             ) AS owner_membership_is_safe,
             pg_catalog.has_function_privilege(
               runtime.oid, function.oid, 'EXECUTE'
             ) AS runtime_can_execute,
             pg_catalog.has_function_privilege(
               caller.oid, function.oid, 'EXECUTE'
             ) AS caller_can_execute,
             EXISTS (
               SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   function.proacl,
                   pg_catalog.acldefault('f', function.proowner)
                 )
               ) AS privilege
               WHERE privilege.grantee = 0
                 AND privilege.privilege_type = 'EXECUTE'
             ) AS public_can_execute,
             EXISTS (
               SELECT 1
               FROM pg_catalog.aclexplode(
                 COALESCE(
                   function.proacl,
                   pg_catalog.acldefault('f', function.proowner)
                 )
               ) AS privilege
               WHERE privilege.privilege_type = 'EXECUTE'
                 AND privilege.grantee NOT IN (owner.oid, runtime.oid)
             ) AS unexpected_execute_grant
      FROM pg_catalog.pg_roles AS owner
      JOIN pg_catalog.pg_roles AS runtime
        ON runtime.rolname = ${RUNTIME_ROLE}
      JOIN pg_catalog.pg_roles AS caller
        ON caller.rolname = ${callerRole!}
      CROSS JOIN pg_catalog.pg_proc AS function
      WHERE owner.rolname = ${EXPIRY_OWNER}
        AND function.oid = ${EXPIRY_FUNCTION}::REGPROCEDURE
    `;
    expect(expiryContract).toEqual({
      caller_can_execute: true,
      owner_bypasses_rls: false,
      owner_can_create: false,
      owner_can_login: false,
      owner_creates_db: false,
      owner_creates_roles: false,
      owner_membership_is_safe: true,
      owner_inherits: false,
      owner_is_superuser: false,
      owner_owns_function: true,
      owner_reads_payload: false,
      owner_reads_required_column: true,
      owner_replicates: false,
      public_can_execute: false,
      runtime_can_execute: true,
      search_path: ['search_path=pg_catalog'],
      security_definer: true,
      unexpected_execute_grant: false,
    });

    const expiryColumnGrants = await db()<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = 'budget_reservations'
        AND grantee = ${EXPIRY_OWNER}
        AND privilege_type = 'SELECT'
      ORDER BY column_name
    `;
    expect(expiryColumnGrants.map((row) => row.column_name)).toEqual([
      'builder_id',
      'decision',
      'expires_at',
      'state',
    ]);

    const functionContracts = await db()<
      Array<{
        argument_defaults: number;
        function_name: string;
        identity_arguments: string;
        kind: string;
        language: string;
        leakproof: boolean;
        owner_name: string;
        parallel_safety: string;
        result_type: string;
        return_type: string;
        returns_set: boolean;
        search_path: string[] | null;
        security_definer: boolean;
        strict: boolean;
        volatility: string;
      }>
    >`
      SELECT procedure.proname AS function_name,
             owner.rolname AS owner_name,
             language.lanname AS language,
             procedure.prokind AS kind,
             procedure.prosecdef AS security_definer,
             procedure.provolatile AS volatility,
             procedure.proisstrict AS strict,
             procedure.proleakproof AS leakproof,
             procedure.proparallel AS parallel_safety,
             procedure.proretset AS returns_set,
             procedure.prorettype::REGTYPE::TEXT AS return_type,
             procedure.pronargdefaults AS argument_defaults,
             procedure.proconfig AS search_path,
             pg_catalog.pg_get_function_identity_arguments(
               procedure.oid
             ) AS identity_arguments,
             pg_catalog.pg_get_function_result(procedure.oid) AS result_type
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner
        ON owner.oid = procedure.proowner
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
      WHERE procedure.oid IN (
        ${DISCOVERY_FUNCTION}::REGPROCEDURE,
        ${EXPIRY_FUNCTION}::REGPROCEDURE
      )
      ORDER BY procedure.proname
    `;
    const exactFunctionContract = {
      argument_defaults: 2,
      identity_arguments: 'p_after_builder_id uuid, p_limit integer',
      kind: 'f',
      language: 'plpgsql',
      leakproof: false,
      parallel_safety: 'u',
      result_type: 'TABLE(builder_id uuid)',
      return_type: 'uuid',
      returns_set: true,
      search_path: ['search_path=pg_catalog'],
      security_definer: true,
      strict: false,
      volatility: 's',
    };
    expect(functionContracts).toEqual([
      {
        ...exactFunctionContract,
        function_name: 'pylva_budget_expiry_actionable_builders',
        owner_name: EXPIRY_OWNER,
      },
      {
        ...exactFunctionContract,
        function_name: 'pylva_budget_projection_actionable_builders',
        owner_name: DISCOVERY_OWNER,
      },
    ]);

    const functionAcl = await db()<
      Array<{
        function_name: string;
        grantee: string;
        is_grantable: boolean;
        privilege: string;
      }>
    >`
      SELECT procedure.proname AS function_name,
             COALESCE(grantee.rolname, 'PUBLIC') AS grantee,
             privilege.privilege_type AS privilege,
             privilege.is_grantable
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE procedure.oid IN (
        ${DISCOVERY_FUNCTION}::REGPROCEDURE,
        ${EXPIRY_FUNCTION}::REGPROCEDURE
      )
      ORDER BY procedure.proname, grantee
    `;
    expect(functionAcl).toEqual([
      {
        function_name: 'pylva_budget_expiry_actionable_builders',
        grantee: RUNTIME_ROLE,
        is_grantable: false,
        privilege: 'EXECUTE',
      },
      {
        function_name: 'pylva_budget_expiry_actionable_builders',
        grantee: EXPIRY_OWNER,
        is_grantable: false,
        privilege: 'EXECUTE',
      },
      {
        function_name: 'pylva_budget_projection_actionable_builders',
        grantee: RUNTIME_ROLE,
        is_grantable: false,
        privilege: 'EXECUTE',
      },
      {
        function_name: 'pylva_budget_projection_actionable_builders',
        grantee: DISCOVERY_OWNER,
        is_grantable: false,
        privilege: 'EXECUTE',
      },
    ]);

    const ownerSchemaAcl = await db()<
      Array<{
        grantee: string;
        is_grantable: boolean;
        privilege: string;
        schema_name: string;
      }>
    >`
      SELECT grantee.rolname AS grantee,
             namespace.nspname AS schema_name,
             privilege.privilege_type AS privilege,
             privilege.is_grantable
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
      JOIN pg_catalog.pg_roles AS grantee
        ON grantee.oid = privilege.grantee
      WHERE grantee.rolname IN (${DISCOVERY_OWNER}, ${EXPIRY_OWNER})
      ORDER BY grantee.rolname, namespace.nspname, privilege.privilege_type
    `;
    expect(ownerSchemaAcl).toEqual([
      {
        grantee: EXPIRY_OWNER,
        is_grantable: false,
        privilege: 'USAGE',
        schema_name: 'public',
      },
      {
        grantee: DISCOVERY_OWNER,
        is_grantable: false,
        privilege: 'USAGE',
        schema_name: 'public',
      },
    ]);
    const [publicSchemaCreate] = await db()<Array<{ granted: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_namespace AS namespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(namespace.nspacl) AS privilege
        WHERE namespace.nspname = 'public'
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'CREATE'
      ) AS granted
    `;
    expect(publicSchemaCreate?.granted).toBe(false);

    const publicObjectAcl = await db()<
      Array<{ object_name: string; object_type: string; privilege: string }>
    >`
      SELECT object.relname AS object_name,
             CASE WHEN object.relkind = 'S' THEN 'sequence' ELSE 'relation' END
               AS object_type,
             privilege.privilege_type AS privilege
      FROM pg_catalog.pg_class AS object
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = object.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(object.relacl) AS privilege
      WHERE namespace.nspname = 'public'
        AND object.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        AND privilege.grantee = 0
      ORDER BY object_type, object.relname, privilege.privilege_type
    `;
    expect(publicObjectAcl).toEqual([]);

    const publicColumnAcl = await db()<
      Array<{ column_name: string; privilege: string; relation_name: string }>
    >`
      SELECT relation.relname AS relation_name,
             attribute.attname AS column_name,
             privilege.privilege_type AS privilege
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      WHERE namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND privilege.grantee = 0
      ORDER BY relation.relname, attribute.attname, privilege.privilege_type
    `;
    expect(publicColumnAcl).toEqual([]);

    const ownerRelations = await db()<Array<{ owner_name: string; relation_name: string }>>`
      SELECT owner.rolname AS owner_name,
             namespace.nspname || '.' || relation.relname AS relation_name
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_roles AS owner
        ON owner.oid = relation.relowner
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE owner.rolname IN (${DISCOVERY_OWNER}, ${EXPIRY_OWNER})
      ORDER BY owner.rolname, relation_name
    `;
    expect(ownerRelations).toEqual([]);

    const effectiveOwnerTableAcl = await db()<
      Array<{ owner_name: string; privilege: string; relation_name: string }>
    >`
      SELECT owner.rolname AS owner_name,
             relation.relname AS relation_name,
             candidate.privilege
      FROM pg_catalog.pg_roles AS owner
      CROSS JOIN pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      CROSS JOIN (
        VALUES
          ('SELECT'),
          ('INSERT'),
          ('UPDATE'),
          ('DELETE'),
          ('TRUNCATE'),
          ('REFERENCES'),
          ('TRIGGER')
      ) AS candidate(privilege)
      WHERE owner.rolname IN (${DISCOVERY_OWNER}, ${EXPIRY_OWNER})
        AND namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_table_privilege(
          owner.oid,
          relation.oid,
          candidate.privilege
        )
      ORDER BY owner.rolname, relation.relname, candidate.privilege
    `;
    expect(effectiveOwnerTableAcl).toEqual([]);

    const effectiveOwnerSequenceAcl = await db()<
      Array<{ owner_name: string; privilege: string; sequence_name: string }>
    >`
      SELECT owner.rolname AS owner_name,
             sequence.relname AS sequence_name,
             candidate.privilege
      FROM pg_catalog.pg_roles AS owner
      CROSS JOIN pg_catalog.pg_class AS sequence
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = sequence.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('UPDATE'), ('USAGE')) AS candidate(privilege)
      WHERE owner.rolname IN (${DISCOVERY_OWNER}, ${EXPIRY_OWNER})
        AND namespace.nspname = 'public'
        AND sequence.relkind = 'S'
        AND pg_catalog.has_sequence_privilege(
          owner.oid,
          sequence.oid,
          candidate.privilege
        )
      ORDER BY owner.rolname, sequence.relname, candidate.privilege
    `;
    expect(effectiveOwnerSequenceAcl).toEqual([]);

    const effectiveOwnerColumnAcl = await db()<
      Array<{
        column_name: string;
        owner_name: string;
        privilege: string;
        relation_name: string;
      }>
    >`
      SELECT owner.rolname AS owner_name,
             relation.relname AS relation_name,
             attribute.attname AS column_name,
             candidate.privilege
      FROM pg_catalog.pg_roles AS owner
      CROSS JOIN pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES'))
        AS candidate(privilege)
      WHERE owner.rolname IN (${DISCOVERY_OWNER}, ${EXPIRY_OWNER})
        AND namespace.nspname = 'public'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND pg_catalog.has_column_privilege(
          owner.oid,
          relation.oid,
          attribute.attnum,
          candidate.privilege
        )
      ORDER BY owner.rolname,
               relation.relname,
               attribute.attname,
               candidate.privilege
    `;
    expect(effectiveOwnerColumnAcl).toEqual([
      {
        column_name: 'builder_id',
        owner_name: EXPIRY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_reservations',
      },
      {
        column_name: 'decision',
        owner_name: EXPIRY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_reservations',
      },
      {
        column_name: 'expires_at',
        owner_name: EXPIRY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_reservations',
      },
      {
        column_name: 'state',
        owner_name: EXPIRY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_reservations',
      },
      {
        column_name: 'attempts',
        owner_name: DISCOVERY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_cost_event_outbox',
      },
      {
        column_name: 'available_at',
        owner_name: DISCOVERY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_cost_event_outbox',
      },
      {
        column_name: 'builder_id',
        owner_name: DISCOVERY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_cost_event_outbox',
      },
      {
        column_name: 'lock_expires_at',
        owner_name: DISCOVERY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_cost_event_outbox',
      },
      {
        column_name: 'projection_verified_at',
        owner_name: DISCOVERY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_cost_event_outbox',
      },
      {
        column_name: 'status',
        owner_name: DISCOVERY_OWNER,
        privilege: 'SELECT',
        relation_name: 'budget_cost_event_outbox',
      },
    ]);

    const policyRows = await db()<
      Array<{
        command: string;
        permissive: string;
        policy_name: string;
        qualifier: string;
        roles: string;
        table_name: string;
      }>
    >`
      SELECT tablename AS table_name,
             policyname AS policy_name,
             permissive,
             roles::TEXT AS roles,
             cmd AS command,
             qual AS qualifier
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND policyname IN (
          'budget_cost_event_outbox_projection_discovery_allow',
          'budget_cost_event_outbox_projection_discovery_limit',
          'budget_reservations_expiry_discovery_allow',
          'budget_reservations_expiry_discovery_limit'
        )
      ORDER BY policyname
    `;
    expect(policyRows).toHaveLength(4);
    for (const row of policyRows) {
      expect(row.command).toBe('SELECT');
      expect(row.roles).toContain(
        row.table_name === 'budget_cost_event_outbox' ? DISCOVERY_OWNER : EXPIRY_OWNER,
      );
      if (row.policy_name.endsWith('_allow')) expect(row.permissive).toBe('PERMISSIVE');
      else expect(row.permissive).toBe('RESTRICTIVE');
      if (row.table_name === 'budget_cost_event_outbox') {
        expect(row.qualifier).toMatch(/status.+pending/);
        expect(row.qualifier).toMatch(/status.+processing/);
        expect(row.qualifier).toMatch(/status.+projected/);
        expect(row.qualifier).toContain('projection_verified_at IS NULL');
      } else {
        expect(row.qualifier).toMatch(/decision.+reserved/);
        expect(row.qualifier).toMatch(/state.+reserved/);
        expect(row.qualifier).toContain('expires_at <= statement_timestamp()');
      }
    }
    const projectionPolicyQualifiers = policyRows
      .filter((row) => row.table_name === 'budget_cost_event_outbox')
      .map((row) => row.qualifier);
    const expiryPolicyQualifiers = policyRows
      .filter((row) => row.table_name === 'budget_reservations')
      .map((row) => row.qualifier);
    expect(new Set(projectionPolicyQualifiers).size).toBe(1);
    expect(new Set(expiryPolicyQualifiers).size).toBe(1);

    const isolationPolicies = await db()<
      Array<{
        command: string;
        permissive: string;
        policy_name: string;
        qualifier: string;
        roles: string;
        with_check: string;
      }>
    >`
      SELECT policyname AS policy_name,
             permissive,
             roles::TEXT AS roles,
             cmd AS command,
             qual AS qualifier,
             with_check
      FROM pg_catalog.pg_policies
      WHERE schemaname = 'public'
        AND policyname IN (
          'budget_cost_event_outbox_isolation',
          'budget_reservations_isolation'
        )
      ORDER BY policyname
    `;
    expect(isolationPolicies).toHaveLength(2);
    for (const policy of isolationPolicies) {
      expect(policy.command).toBe('ALL');
      expect(policy.permissive).toBe('PERMISSIVE');
      expect(policy.roles).toBe('{public}');
      expect(policy.qualifier).toContain('pg_input_is_valid');
      expect(policy.qualifier).toContain("current_setting('app.builder_id'::text, true)");
      expect(policy.with_check).toBe(policy.qualifier);
    }

    const functionDefinitions = await db()<Array<{ definition: string; function_name: string }>>`
      SELECT procedure.proname AS function_name,
             pg_catalog.pg_get_functiondef(procedure.oid) AS definition
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.oid IN (
        ${DISCOVERY_FUNCTION}::REGPROCEDURE,
        ${EXPIRY_FUNCTION}::REGPROCEDURE
      )
      ORDER BY procedure.proname
    `;
    const projectionDefinition = functionDefinitions.find(
      (row) => row.function_name === 'pylva_budget_projection_actionable_builders',
    )?.definition;
    const expiryDefinition = functionDefinitions.find(
      (row) => row.function_name === 'pylva_budget_expiry_actionable_builders',
    )?.definition;
    expect(projectionDefinition).toContain("outbox.status = 'pending'");
    expect(projectionDefinition).toContain(
      'outbox.available_at <= pg_catalog.statement_timestamp()',
    );
    expect(projectionDefinition).toContain('outbox.attempts < 2147483646');
    expect(projectionDefinition).toContain("outbox.status = 'processing'");
    expect(projectionDefinition).toContain(
      'outbox.lock_expires_at <= pg_catalog.statement_timestamp()',
    );
    expect(projectionDefinition).toContain("outbox.status = 'projected'");
    expect(projectionDefinition).toContain('outbox.projection_verified_at IS NULL');
    expect(expiryDefinition).toContain("reservation.decision = 'reserved'");
    expect(expiryDefinition).toContain("reservation.state = 'reserved'");
    expect(expiryDefinition).toContain(
      'reservation.expires_at <= pg_catalog.statement_timestamp()',
    );

    const forcedRls = await db()<
      Array<{ force_rls: boolean; rls_enabled: boolean; table_name: string }>
    >`
      SELECT relname AS table_name,
             relrowsecurity AS rls_enabled,
             relforcerowsecurity AS force_rls
      FROM pg_catalog.pg_class
      WHERE oid IN (
        'public.builders'::REGCLASS,
        'public.rules'::REGCLASS,
        'public.cost_sources'::REGCLASS,
        'public.custom_pricing'::REGCLASS,
        'public.budget_account_opening_evidence'::REGCLASS,
        'public.budget_accounts'::REGCLASS,
        'public.budget_control_cutovers'::REGCLASS,
        'public.budget_cost_event_outbox'::REGCLASS,
        'public.budget_reservation_allocations'::REGCLASS,
        'public.budget_reservation_transitions'::REGCLASS,
        'public.budget_reservations'::REGCLASS,
        'public.budget_rule_revisions'::REGCLASS,
        'public.budget_usage_ledger'::REGCLASS
      )
      ORDER BY relname
    `;
    expect(forcedRls).toEqual([
      { force_rls: true, rls_enabled: true, table_name: 'budget_account_opening_evidence' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_accounts' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_control_cutovers' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_cost_event_outbox' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_reservation_allocations' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_reservation_transitions' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_reservations' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_rule_revisions' },
      { force_rls: true, rls_enabled: true, table_name: 'budget_usage_ledger' },
      { force_rls: false, rls_enabled: true, table_name: 'builders' },
      { force_rls: false, rls_enabled: true, table_name: 'cost_sources' },
      { force_rls: false, rls_enabled: true, table_name: 'custom_pricing' },
      { force_rls: false, rls_enabled: true, table_name: 'rules' },
    ]);

    const [runtimePrivileges] = await db()<
      Array<{
        can_connect: boolean;
        can_read_api_keys: boolean;
        can_read_customers: boolean;
        can_read_migration_ledger: boolean;
        can_read_users: boolean;
        can_use_schema: boolean;
      }>
    >`
      SELECT pg_catalog.has_database_privilege(
               runtime.oid, pg_catalog.current_database(), 'CONNECT'
             ) AS can_connect,
             pg_catalog.has_schema_privilege(
               runtime.oid, 'public', 'USAGE'
             ) AS can_use_schema,
             pg_catalog.has_table_privilege(
               runtime.oid, 'public.api_keys', 'SELECT'
             ) AS can_read_api_keys,
             pg_catalog.has_table_privilege(
               runtime.oid, 'public.customers', 'SELECT'
             ) AS can_read_customers,
             pg_catalog.has_table_privilege(
               runtime.oid, 'public.users', 'SELECT'
             ) AS can_read_users,
             pg_catalog.has_table_privilege(
               runtime.oid, 'public.schema_migrations', 'SELECT'
             ) AS can_read_migration_ledger
      FROM pg_catalog.pg_roles AS runtime
      WHERE runtime.rolname = ${RUNTIME_ROLE}
    `;
    expect(runtimePrivileges).toEqual({
      can_connect: true,
      can_read_api_keys: false,
      can_read_customers: false,
      can_read_migration_ledger: false,
      can_read_users: false,
      can_use_schema: true,
    });

    const unrelatedEffectivePrivileges = await db()<
      Array<{ privilege: string; table_name: string }>
    >`
      SELECT relation.relname AS table_name, candidate.privilege
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_roles AS runtime
        ON runtime.rolname = ${RUNTIME_ROLE}
      CROSS JOIN (
        VALUES
          ('SELECT'),
          ('INSERT'),
          ('UPDATE'),
          ('DELETE'),
          ('TRUNCATE'),
          ('REFERENCES'),
          ('TRIGGER')
      ) AS candidate(privilege)
      WHERE relation.relnamespace = 'public'::REGNAMESPACE
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND relation.relname <> ALL (ARRAY[
          'budget_accounts',
          'budget_rule_revisions',
          'budget_reservations',
          'budget_reservation_allocations',
          'budget_reservation_transitions',
          'budget_usage_ledger',
          'budget_cost_event_outbox',
          'budget_control_cutovers',
          'budget_account_opening_evidence',
          'builders',
          'cost_sources',
          'custom_pricing',
          'llm_pricing',
          'rules'
        ]::TEXT[])
        AND pg_catalog.has_table_privilege(
          runtime.oid,
          relation.oid,
          candidate.privilege
        )
      ORDER BY relation.relname, candidate.privilege
    `;
    expect(unrelatedEffectivePrivileges).toEqual([]);

    const runtimeColumnGrants = await db()<
      Array<{ column_name: string; privilege: string; table_name: string }>
    >`
      SELECT relation.relname AS table_name,
             attribute.attname AS column_name,
             privilege.privilege_type AS privilege
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
      JOIN pg_catalog.pg_roles AS runtime
        ON runtime.oid = privilege.grantee
      WHERE relation.relnamespace = 'public'::REGNAMESPACE
        AND attribute.attacl IS NOT NULL
        AND runtime.rolname = ${RUNTIME_ROLE}
      ORDER BY relation.relname, attribute.attnum, privilege.privilege_type
    `;
    expect(runtimeColumnGrants).toEqual([]);

    const relationPrivileges = await db()<Array<{ privileges: string[]; table_name: string }>>`
      SELECT grants.table_name,
             array_agg(grants.privilege_type ORDER BY grants.privilege_type) AS privileges
      FROM information_schema.role_table_grants AS grants
      WHERE grants.grantee = ${RUNTIME_ROLE}
        AND grants.table_schema = 'public'
      GROUP BY grants.table_name
      ORDER BY grants.table_name
    `;
    expect(relationPrivileges).toEqual([
      { privileges: ['INSERT', 'SELECT'], table_name: 'budget_account_opening_evidence' },
      { privileges: ['INSERT', 'SELECT', 'UPDATE'], table_name: 'budget_accounts' },
      { privileges: ['INSERT', 'SELECT', 'UPDATE'], table_name: 'budget_control_cutovers' },
      { privileges: ['INSERT', 'SELECT', 'UPDATE'], table_name: 'budget_cost_event_outbox' },
      {
        privileges: ['INSERT', 'SELECT', 'UPDATE'],
        table_name: 'budget_reservation_allocations',
      },
      { privileges: ['INSERT', 'SELECT'], table_name: 'budget_reservation_transitions' },
      { privileges: ['INSERT', 'SELECT', 'UPDATE'], table_name: 'budget_reservations' },
      { privileges: ['INSERT', 'SELECT', 'UPDATE'], table_name: 'budget_rule_revisions' },
      { privileges: ['INSERT', 'SELECT'], table_name: 'budget_usage_ledger' },
      { privileges: ['SELECT'], table_name: 'builders' },
      { privileges: ['SELECT'], table_name: 'cost_sources' },
      { privileges: ['SELECT'], table_name: 'custom_pricing' },
      { privileges: ['SELECT'], table_name: 'llm_pricing' },
      { privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], table_name: 'rules' },
    ]);

    const sequencePrivileges = await db()<{ privileges: string[]; sequence_name: string }[]>`
      SELECT sequence.relname AS sequence_name,
             array_agg(candidate.privilege ORDER BY candidate.privilege) AS privileges
      FROM pg_catalog.pg_class AS sequence
      JOIN pg_catalog.pg_roles AS runtime
        ON runtime.rolname = ${RUNTIME_ROLE}
      CROSS JOIN (
        VALUES ('SELECT'), ('UPDATE'), ('USAGE')
      ) AS candidate(privilege)
      WHERE sequence.relnamespace = 'public'::REGNAMESPACE
        AND sequence.relkind = 'S'
        AND pg_catalog.has_sequence_privilege(
          runtime.oid,
          sequence.oid,
          candidate.privilege
        )
      GROUP BY sequence.relname
      ORDER BY sequence.relname
    `;
    expect(sequencePrivileges).toEqual([
      { privileges: ['USAGE'], sequence_name: 'pylva_budget_authority_order_seq' },
    ]);

    const [defaultPrivilegeCount] = await db()<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count
      FROM pg_catalog.pg_default_acl AS defaults
      CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) AS privilege
      CROSS JOIN pg_catalog.pg_roles AS runtime
      WHERE runtime.rolname = ${RUNTIME_ROLE}
        AND defaults.defaclobjtype IN ('r', 'S')
        AND privilege.grantee IN (0, runtime.oid)
    `;
    expect(defaultPrivilegeCount?.count).toBe('0');
  });

  it('preserves owner-based legacy bootstrap access without weakening the dedicated runtime', async () => {
    const legacyBuilderIds = [
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002',
      '70000000-0000-4000-8000-000000000003',
    ] as const;
    const ruleId = '71000000-0000-4000-8000-000000000001';

    const [ownerPosture] = await db()<
      Array<{
        bypasses_rls: boolean;
        owns_all_legacy_catalogs: boolean;
        is_superuser: boolean;
      }>
    >`
      SELECT role.rolsuper AS is_superuser,
             role.rolbypassrls AS bypasses_rls,
             pg_catalog.bool_and(relation.relowner = role.oid)
               AS owns_all_legacy_catalogs
      FROM pg_catalog.pg_roles AS role
      CROSS JOIN pg_catalog.pg_class AS relation
      WHERE role.rolname = CURRENT_USER
        AND relation.oid IN (
          'public.builders'::REGCLASS,
          'public.rules'::REGCLASS,
          'public.cost_sources'::REGCLASS,
          'public.custom_pricing'::REGCLASS
        )
      GROUP BY role.oid, role.rolsuper, role.rolbypassrls
    `;
    expect(ownerPosture).toEqual({
      bypasses_rls: false,
      owns_all_legacy_catalogs: true,
      is_superuser: false,
    });

    const ownerLifecycle = await db().begin(async (transaction) => {
      const [context] = await transaction<Array<{ builder_context: string | null }>>`
        SELECT pg_catalog.current_setting('app.builder_id', TRUE) AS builder_context
      `;
      expect([null, '']).toContain(context?.builder_context ?? null);

      const insertedBuilders = await transaction<{ id: string }[]>`
        INSERT INTO public.builders (id, email, name, tier, slug)
        VALUES
          (
            ${legacyBuilderIds[0]}::UUID,
            'legacy-owner-1@example.test',
            'legacy owner 1',
            'free',
            'legacy-owner-1'
          ),
          (
            ${legacyBuilderIds[1]}::UUID,
            'legacy-owner-2@example.test',
            'legacy owner 2',
            'free',
            'legacy-owner-2'
          ),
          (
            ${legacyBuilderIds[2]}::UUID,
            'legacy-owner-3@example.test',
            'legacy owner 3',
            'free',
            'legacy-owner-3'
          )
        RETURNING id::TEXT AS id
      `;

      await transaction`
        INSERT INTO public.rules (
          id, builder_id, type, enforcement, name, enabled, config,
          customer_id, status
        ) VALUES (
          ${ruleId}::UUID,
          ${legacyBuilderIds[0]}::UUID,
          'cost_threshold',
          'post_call',
          'legacy owner write',
          TRUE,
          ${pgJsonbParameterText({ threshold_usd: 1 })}::TEXT::JSONB,
          NULL,
          'active'
        )
      `;
      await transaction`
        INSERT INTO public.cost_sources (
          builder_id, source_type, display_name, slug, metric, unit,
          price_per_unit, status, tracking_status
        ) VALUES (
          ${legacyBuilderIds[0]}::UUID,
          'non_llm_manual',
          'Legacy owner source',
          'legacy-owner-source',
          'request',
          'request',
          0.01,
          'healthy',
          'tracked'
        )
      `;
      await transaction`
        INSERT INTO public.custom_pricing (
          builder_id, provider, model, metric, price_per_unit_usd,
          effective_from, source
        ) VALUES (
          ${legacyBuilderIds[0]}::UUID,
          NULL,
          NULL,
          'legacy_owner_metric',
          0.01,
          pg_catalog.statement_timestamp(),
          'builder_manual'
        )
      `;

      const [catalogCounts] = await transaction<
        Array<{
          builders: string;
          cost_sources: string;
          custom_pricing: string;
          rules: string;
        }>
      >`
        SELECT (
                 SELECT pg_catalog.count(*)::TEXT
                 FROM public.builders
                 WHERE id = ANY(${legacyBuilderIds}::UUID[])
               ) AS builders,
               (
                 SELECT pg_catalog.count(*)::TEXT
                 FROM public.rules
                 WHERE builder_id = ${legacyBuilderIds[0]}::UUID
               ) AS rules,
               (
                 SELECT pg_catalog.count(*)::TEXT
                 FROM public.cost_sources
                 WHERE builder_id = ${legacyBuilderIds[0]}::UUID
               ) AS cost_sources,
               (
                 SELECT pg_catalog.count(*)::TEXT
                 FROM public.custom_pricing
                 WHERE builder_id = ${legacyBuilderIds[0]}::UUID
               ) AS custom_pricing
      `;

      const updatedBuilders = await transaction<{ id: string }[]>`
        UPDATE public.builders
        SET name = 'legacy owner updated'
        WHERE id = ${legacyBuilderIds[0]}::UUID
        RETURNING id::TEXT AS id
      `;
      await transaction`
        DELETE FROM public.rules
        WHERE builder_id = ${legacyBuilderIds[0]}::UUID
      `;
      await transaction`
        DELETE FROM public.cost_sources
        WHERE builder_id = ${legacyBuilderIds[0]}::UUID
      `;
      await transaction`
        DELETE FROM public.custom_pricing
        WHERE builder_id = ${legacyBuilderIds[0]}::UUID
      `;
      const deletedBuilders = await transaction<{ id: string }[]>`
        DELETE FROM public.builders
        WHERE id = ANY(${legacyBuilderIds}::UUID[])
        RETURNING id::TEXT AS id
      `;

      return { catalogCounts, deletedBuilders, insertedBuilders, updatedBuilders };
    });

    expect(ownerLifecycle.catalogCounts).toEqual({
      builders: '3',
      cost_sources: '1',
      custom_pricing: '1',
      rules: '1',
    });
    expect(ownerLifecycle.insertedBuilders.map((row) => row.id)).toEqual(legacyBuilderIds);
    expect(ownerLifecycle.updatedBuilders).toEqual([{ id: legacyBuilderIds[0] }]);
    expect(ownerLifecycle.deletedBuilders.map((row) => row.id).sort()).toEqual(
      [...legacyBuilderIds].sort(),
    );

    expect(await attestBudgetControlRuntime(callerSql!)).toBeNull();
    const runtimeTenantView = await callerSql!.begin(async (transaction) => {
      await useBuilder(transaction, BUILDER_IDS.pending);
      const own = await transaction<{ id: string }[]>`
        SELECT id::TEXT AS id
        FROM public.builders
        WHERE id = ${BUILDER_IDS.pending}::UUID
      `;
      const crossTenant = await transaction<{ id: string }[]>`
        SELECT id::TEXT AS id
        FROM public.builders
        WHERE id = ${BUILDER_IDS.expiredProcessing}::UUID
      `;
      return { crossTenant, own };
    });
    expect(runtimeTenantView).toEqual({
      crossTenant: [],
      own: [{ id: BUILDER_IDS.pending }],
    });
  });

  it('denies direct tenant scans and returns only actionable builders by UUID keyset', async () => {
    expect(callerSql).toBeDefined();
    expect(await attestBudgetControlRuntime(callerSql!)).toBeNull();
    expect(
      await callerSql!<{ builder_id: string }[]>`
      SELECT builder_id FROM public.budget_cost_event_outbox
    `,
    ).toEqual([]);
    const crossTenantRows = await callerSql!.begin(async (transaction) => {
      await useBuilder(transaction, BUILDER_IDS.pending);
      return transaction<{ builder_id: string }[]>`
        SELECT builder_id
        FROM public.budget_cost_event_outbox
        WHERE builder_id = ${BUILDER_IDS.expiredProcessing}::UUID
      `;
    });
    expect(crossTenantRows).toEqual([]);

    expect(await discover(callerSql!, null, 2)).toEqual(EXPECTED_ACTIONABLE.slice(0, 2));
    expect(await discover(callerSql!, EXPECTED_ACTIONABLE[1], 2)).toEqual([EXPECTED_ACTIONABLE[2]]);
    expect(await discover(callerSql!, EXPECTED_ACTIONABLE[2], 2)).toEqual([]);
    expect(await discover(callerSql!, BUILDER_IDS.pending, 1)).toEqual([
      BUILDER_IDS.expiredProcessing,
    ]);

    const runtimeStore = createBudgetProjectionPostgresStore(callerSql!);
    expect(await runtimeStore.listBuilderPage(null, 1000)).toEqual(EXPECTED_ACTIONABLE);
  });

  it('discovers only tenants with due reserved leases through bounded UUID keysets', async () => {
    expect(
      await callerSql!<{ builder_id: string }[]>`
      SELECT builder_id FROM public.budget_reservations
    `,
    ).toEqual([]);
    const crossTenantRows = await callerSql!.begin(async (transaction) => {
      await useBuilder(transaction, BUILDER_IDS.pending);
      return transaction<{ builder_id: string }[]>`
        SELECT builder_id
        FROM public.budget_reservations
        WHERE builder_id = ${BUILDER_IDS.expiredProcessing}::UUID
      `;
    });
    expect(crossTenantRows).toEqual([]);

    expect(await discoverExpiry(callerSql!, null, 1)).toEqual([EXPECTED_EXPIRY_ACTIONABLE[0]]);
    expect(await discoverExpiry(callerSql!, EXPECTED_EXPIRY_ACTIONABLE[0], 10)).toEqual([
      EXPECTED_EXPIRY_ACTIONABLE[1],
    ]);
    expect(await discoverExpiry(callerSql!, EXPECTED_EXPIRY_ACTIONABLE[1], 10)).toEqual([]);
  });

  it('uses all three selective outbox indexes at high cardinality with seqscans enabled', async () => {
    const [indexContract] = await db()<
      Array<{
        definition: string;
        is_ready: boolean;
        is_valid: boolean;
        predicate: string;
      }>
    >`
      SELECT pg_catalog.pg_get_indexdef(index.indexrelid) AS definition,
             pg_catalog.pg_get_expr(index.indpred, index.indrelid) AS predicate,
             index.indisvalid AS is_valid,
             index.indisready AS is_ready
      FROM pg_catalog.pg_index AS index
      WHERE index.indexrelid =
        'public.idx_budget_cost_event_outbox_projected_unverified'::REGCLASS
    `;
    expect(indexContract).toMatchObject({ is_ready: true, is_valid: true });
    expect(indexContract?.definition).toContain('USING btree (builder_id)');
    expect(indexContract?.predicate).toMatch(/status.+projected/);
    expect(indexContract?.predicate).toContain('projection_verified_at IS NULL');

    // Verified history is the dominant production shape. Seed 100k valid
    // tombstones in this disposable database so the planner gate proves the
    // actionable OR query stays selective without disabling sequential scans.
    await db().begin(async (transaction) => {
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        NO FORCE ROW LEVEL SECURITY
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        DISABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await transaction.unsafe(`
        WITH fixture AS (
          SELECT series.value,
                 date_trunc(
                   'milliseconds',
                   statement_timestamp() - INTERVAL '1 hour'
                 ) AS fixture_time
          FROM generate_series(1, 100000) AS series(value)
        )
        INSERT INTO public.budget_cost_event_outbox (
          builder_id,
          id,
          usage_ledger_id,
          cost_event_id,
          payload_schema_version,
          payload,
          payload_hash,
          status,
          attempts,
          available_at,
          last_attempt_at,
          projected_at,
          projection_verified_at,
          payload_purged_at,
          created_at,
          updated_at
        )
        SELECT (
                 '20000000-0000-4000-8000-'
                 || lpad(to_hex(fixture.value), 12, '0')
               )::UUID,
               (
                 '30000000-0000-4000-8000-'
                 || lpad(to_hex(fixture.value), 12, '0')
               )::UUID,
               (
                 '40000000-0000-4000-8000-'
                 || lpad(to_hex(fixture.value), 12, '0')
               )::UUID,
               (
                 '50000000-0000-4000-8000-'
                 || lpad(to_hex(fixture.value), 12, '0')
               )::UUID,
               '1.6',
               NULL,
               repeat('0', 64),
               'projected',
               1,
               fixture.fixture_time,
               fixture.fixture_time,
               fixture.fixture_time,
               fixture.fixture_time,
               fixture.fixture_time,
               fixture.fixture_time,
               fixture.fixture_time
        FROM fixture
      `);
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        ENABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        FORCE ROW LEVEL SECURITY
      `;
    });
    await db().unsafe('ANALYZE public.budget_cost_event_outbox');

    const plan = await db().begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL enable_seqscan = ON');
      const [plannerSetting] = await transaction<Array<{ enable_seqscan: string }>>`
        SHOW enable_seqscan
      `;
      expect(plannerSetting?.enable_seqscan).toBe('on');
      await transaction.unsafe(`
        GRANT ${DISCOVERY_OWNER} TO CURRENT_USER
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
        GRANTED BY CURRENT_USER
      `);
      await transaction.unsafe(`SET LOCAL ROLE ${DISCOVERY_OWNER}`);
      const [row] = await transaction<Array<{ 'QUERY PLAN': unknown }>>`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT actionable.builder_id
        FROM (
          SELECT outbox.builder_id
          FROM public.budget_cost_event_outbox AS outbox
          WHERE outbox.builder_id >
                  '00000000-0000-0000-0000-000000000000'::UUID
            AND (
              (
                outbox.status = 'pending'
                AND outbox.available_at <= pg_catalog.statement_timestamp()
                AND outbox.attempts < 2147483646
              )
              OR (
                outbox.status = 'processing'
                AND outbox.lock_expires_at <= pg_catalog.statement_timestamp()
              )
              OR (
                outbox.status = 'projected'
                AND outbox.projection_verified_at IS NULL
              )
            )
          GROUP BY outbox.builder_id
        ) AS actionable
        ORDER BY actionable.builder_id
        LIMIT 250
      `;
      await transaction.unsafe('RESET ROLE');
      await transaction.unsafe(`
        REVOKE ${DISCOVERY_OWNER} FROM CURRENT_USER
        GRANTED BY CURRENT_USER
      `);
      return row?.['QUERY PLAN'];
    });

    const planNodes = collectPlanNodes(plan);
    const nodeTypes = planNodes.map((node) => node['Node Type']);
    const indexNames = planNodes
      .map((node) => node['Index Name'])
      .filter((name): name is string => typeof name === 'string');
    expect(nodeTypes).not.toContain('Seq Scan');
    expect(indexNames).toEqual(
      expect.arrayContaining([
        'idx_budget_cost_event_outbox_pending',
        'idx_budget_cost_event_outbox_expired_lease',
        'idx_budget_cost_event_outbox_projected_unverified',
      ]),
    );
  });

  it('keeps due-expiry discovery on its bounded partial-index plan', async () => {
    const [indexContract] = await db()<
      Array<{
        definition: string;
        is_ready: boolean;
        is_valid: boolean;
        predicate: string;
      }>
    >`
      SELECT pg_catalog.pg_get_indexdef(index.indexrelid) AS definition,
             pg_catalog.pg_get_expr(index.indpred, index.indrelid) AS predicate,
             index.indisvalid AS is_valid,
             index.indisready AS is_ready
      FROM pg_catalog.pg_index AS index
      WHERE index.indexrelid =
        'public.idx_budget_reservations_expiry_discovery'::REGCLASS
    `;
    expect(indexContract).toMatchObject({ is_ready: true, is_valid: true });
    expect(indexContract?.definition).toContain(
      'USING btree (builder_id, expires_at, decision_id)',
    );
    expect(indexContract?.predicate).toMatch(/state.+reserved/);
    expect(indexContract?.predicate).toMatch(/decision.+reserved/);

    const plan = await db().begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL enable_seqscan = OFF');
      await transaction.unsafe(`
        GRANT ${EXPIRY_OWNER} TO CURRENT_USER
        WITH ADMIN FALSE, INHERIT FALSE, SET TRUE
        GRANTED BY CURRENT_USER
      `);
      await transaction.unsafe(`SET LOCAL ROLE ${EXPIRY_OWNER}`);
      const [row] = await transaction<Array<{ 'QUERY PLAN': unknown }>>`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT reservation.builder_id
        FROM public.budget_reservations AS reservation
        WHERE reservation.builder_id >
              '00000000-0000-0000-0000-000000000000'::UUID
          AND reservation.decision = 'reserved'
          AND reservation.state = 'reserved'
          AND reservation.expires_at <= pg_catalog.statement_timestamp()
        ORDER BY reservation.builder_id ASC, reservation.expires_at ASC
        LIMIT 250
      `;
      await transaction.unsafe('RESET ROLE');
      await transaction.unsafe(`
        REVOKE ${EXPIRY_OWNER} FROM CURRENT_USER
        GRANTED BY CURRENT_USER
      `);
      return row?.['QUERY PLAN'];
    });
    const serializedPlan = JSON.stringify(plan);
    expect(serializedPlan).toContain('"Node Type":"Limit"');
    expect(serializedPlan).toContain('"Index Name":"idx_budget_reservations_expiry_discovery"');
  });

  it('runs the atomic rule create-disable-delete lifecycle and activates readiness', async () => {
    const ruleKey = crypto.randomUUID();
    const config = {
      hard_stop: true,
      limit_usd: 25,
      period: 'day',
      scope: 'pooled',
    };
    const createdRevision = await withBudgetBuilderTransaction(
      BUILDER_IDS.pending,
      'exclusive',
      async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
        INSERT INTO public.rules (
            id, builder_id, type, enforcement, name, enabled, config,
            customer_id, status
        ) VALUES (
          ${ruleKey}::UUID,
          ${BUILDER_IDS.pending}::UUID,
          'budget_limit',
          'pre_call',
            'runtime atomic lifecycle',
          TRUE,
          ${pgJsonbParameterText(config)}::TEXT::JSONB,
          NULL,
          'active'
        )
          RETURNING id::TEXT AS id
        `;
        expect(rows).toEqual([{ id: ruleKey }]);
        return reconcileBudgetRuleRevisionInTransaction(transaction, BUILDER_IDS.pending, ruleKey);
      },
      { client: callerSql!, maxAttempts: 1 },
    );
    expect(createdRevision).toMatchObject({
      action: 'created',
      revision: '0',
      rule_key: ruleKey,
    });

    const disabled = await withBudgetRuleRevisionMutation(
      BUILDER_IDS.pending,
      ruleKey,
      async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          UPDATE public.rules
          SET enabled = FALSE,
              updated_at = pg_catalog.transaction_timestamp()
          WHERE builder_id = ${BUILDER_IDS.pending}::UUID
            AND id = ${ruleKey}::UUID
          RETURNING id::TEXT AS id
        `;
        return { kind: 'upsert', value: rows.length };
      },
      { client: callerSql!, maxAttempts: 1 },
    );
    expect(disabled).toMatchObject({
      value: 1,
      revision: { action: 'disabled', revision: '0', rule_key: ruleKey },
    });

    const deleted = await withBudgetRuleRevisionMutation(
      BUILDER_IDS.pending,
      ruleKey,
      async (transaction) => {
        const rows = await transaction<{ id: string }[]>`
          DELETE FROM public.rules
          WHERE builder_id = ${BUILDER_IDS.pending}::UUID
            AND id = ${ruleKey}::UUID
          RETURNING id::TEXT AS id
        `;
        return { kind: 'delete', value: rows.length };
      },
      { client: callerSql!, maxAttempts: 1 },
    );
    expect(deleted).toMatchObject({
      value: 1,
      revision: { action: 'deleted', revision: '1', rule_key: ruleKey },
    });

    const lifecycle = await callerSql!.begin(async (transaction) => {
      await useBuilder(transaction, BUILDER_IDS.pending);
      const [rules, revisions] = await Promise.all([
        transaction<{ count: string }[]>`
          SELECT COUNT(*)::TEXT AS count
          FROM public.rules
          WHERE builder_id = ${BUILDER_IDS.pending}::UUID
            AND id = ${ruleKey}::UUID
        `,
        transaction<
          Array<{
            retirement_reason: string | null;
            retired: boolean;
            revision: string;
          }>
        >`
          SELECT revision::TEXT AS revision,
                 retirement_reason,
                 retired_at IS NOT NULL AS retired
          FROM public.budget_rule_revisions
          WHERE builder_id = ${BUILDER_IDS.pending}::UUID
            AND rule_key = ${ruleKey}::UUID
          ORDER BY revision
        `,
      ]);
      return { rules, revisions };
    });
    expect(lifecycle).toEqual({
      rules: [{ count: '0' }],
      revisions: [
        { retirement_reason: 'disabled', retired: true, revision: '0' },
        { retirement_reason: 'deleted', retired: true, revision: '1' },
      ],
    });

    const pending = await createBudgetControlCutover(BUILDER_IDS.pending, 'exact_backfill', {
      client: callerSql!,
    });
    expect(pending).toMatchObject({ ready: false, reason: 'pending', mode: 'exact_backfill' });
    const ready = await markBudgetControlReady(BUILDER_IDS.pending, {
      activateExactBackfill: async () => undefined,
      client: callerSql!,
    });
    expect(ready).toMatchObject({ ready: true, mode: 'exact_backfill' });

    await expect(
      callerSql!.begin(async (transaction) => {
        await useBuilder(transaction, BUILDER_IDS.pending);
        return transaction`SELECT id FROM public.api_keys`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('prices, reserves, and commits LLM and tool usage through the dedicated login', async () => {
    await db()`
      INSERT INTO public.llm_pricing (
        provider, model, input_per_1m, output_per_1m, effective_from, source
      ) VALUES (
        'runtime-openai', 'runtime-gpt', 20, 40,
        pg_catalog.statement_timestamp() - INTERVAL '1 day', 'admin'
      )
    `;
    await db().begin(async (transaction) => {
      await useBuilder(transaction, BUILDER_IDS.pending);
      await transaction`
        INSERT INTO public.custom_pricing (
          builder_id, provider, model, price_per_unit_usd,
          input_per_1m_usd, output_per_1m_usd, effective_from, source
        ) VALUES (
          ${BUILDER_IDS.pending}::UUID,
          'runtime-openai',
          'runtime-gpt',
          0,
          2,
          4,
          pg_catalog.statement_timestamp() - INTERVAL '1 hour',
          'builder_manual'
        )
      `;
      await transaction`
        INSERT INTO public.cost_sources (
          builder_id, source_type, display_name, slug, metric, unit,
          price_per_unit, status, approved_at, tracking_status
        ) VALUES (
          ${BUILDER_IDS.pending}::UUID,
          'non_llm_manual',
          'Runtime search',
          'runtime-search',
          'credit',
          'credit',
          0.25,
          'healthy',
          pg_catalog.statement_timestamp() - INTERVAL '1 hour',
          'tracked'
        )
      `;
    });

    const ruleKey = crypto.randomUUID();
    const ruleConfig = {
      hard_stop: true,
      limit_usd: 100,
      period: 'day',
      scope: 'pooled',
    };
    const ruleRevision = await withBudgetBuilderTransaction(
      BUILDER_IDS.pending,
      'exclusive',
      async (transaction) => {
        await transaction`
          INSERT INTO public.rules (
            id, builder_id, type, enforcement, name, enabled, config,
            customer_id, status
          ) VALUES (
            ${ruleKey}::UUID,
            ${BUILDER_IDS.pending}::UUID,
            'budget_limit',
            'pre_call',
            'runtime pricing lifecycle',
            TRUE,
            ${pgJsonbParameterText(ruleConfig)}::TEXT::JSONB,
            NULL,
            'active'
          )
        `;
        return reconcileBudgetRuleRevisionInTransaction(transaction, BUILDER_IDS.pending, ruleKey);
      },
      { client: callerSql!, maxAttempts: 1 },
    );
    expect(ruleRevision).toMatchObject({ action: 'created', revision: '0' });

    const reserve = createReserveBudgetUsage({
      client: callerSql!,
      controlEnabled: () => true,
      maxAttempts: 1,
      sleep: async () => undefined,
    });
    const lifecycle = createBudgetLifecycleService({
      transactionOptions: { client: callerSql!, maxAttempts: 1 },
    });

    const llmReservation = await reserve(BUILDER_IDS.pending, llmReserveRequest(), SDK_IDENTITY);
    expect(llmReservation).toMatchObject({
      decision: 'reserved',
      reserved_usd: '0.0004',
    });
    if (llmReservation.decision !== 'reserved') {
      throw new Error('LLM runtime pricing journey did not reserve');
    }
    const llmCommit = v.parse(CommitUsageRequestSchema, {
      schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
      status: 'success',
      latency_ms: 120,
      stream_aborted: false,
      kind: 'llm',
      actual_input_tokens: 80,
      actual_output_tokens: 20,
    });
    await expect(
      lifecycle.commitBudgetUsage(
        BUILDER_IDS.pending,
        llmReservation.reservation_id,
        llmCommit,
        SDK_IDENTITY,
      ),
    ).resolves.toMatchObject({ state: 'committed', actual_usd: '0.00024' });

    const toolReservation = await reserve(BUILDER_IDS.pending, toolReserveRequest(), SDK_IDENTITY);
    expect(toolReservation).toMatchObject({
      decision: 'reserved',
      reserved_usd: '0.5',
    });
    if (toolReservation.decision !== 'reserved') {
      throw new Error('tool runtime pricing journey did not reserve');
    }
    const toolCommit = v.parse(CommitUsageRequestSchema, {
      schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
      status: 'success',
      latency_ms: 80,
      stream_aborted: false,
      kind: 'tool',
      actual_value: '1.5',
    });
    await expect(
      lifecycle.commitBudgetUsage(
        BUILDER_IDS.pending,
        toolReservation.reservation_id,
        toolCommit,
        SDK_IDENTITY,
      ),
    ).resolves.toMatchObject({ state: 'committed', actual_usd: '0.375' });

    const committedRows = await callerSql!.begin(async (transaction) => {
      await useBuilder(transaction, BUILDER_IDS.pending);
      return transaction<
        Array<{
          actual_usd: string;
          billing_retention_days: number;
          kind: string;
          outbox_created: boolean;
          retention_days: number;
        }>
      >`
        SELECT ledger.kind,
               public.pylva_budget_decimal_text(ledger.actual_cost_usd) AS actual_usd,
               ledger.retention_days,
               ledger.billing_retention_days,
               outbox.id IS NOT NULL AS outbox_created
        FROM public.budget_usage_ledger AS ledger
        JOIN public.budget_cost_event_outbox AS outbox
          ON outbox.builder_id = ledger.builder_id
         AND outbox.usage_ledger_id = ledger.id
        WHERE ledger.builder_id = ${BUILDER_IDS.pending}::UUID
          AND ledger.reservation_decision_id IN (
            ${llmReservation.decision_id}::UUID,
            ${toolReservation.decision_id}::UUID
          )
        ORDER BY ledger.kind
      `;
    });
    expect(committedRows).toEqual([
      {
        actual_usd: '0.00024',
        billing_retention_days: 365,
        kind: 'llm',
        outbox_created: true,
        retention_days: 90,
      },
      {
        actual_usd: '0.375',
        billing_retention_days: 365,
        kind: 'tool',
        outbox_created: true,
        retention_days: 90,
      },
    ]);
  });

  it('rejects null, zero, negative, and oversized page bounds', async () => {
    for (const invalidLimit of [null, 0, -1, 1001]) {
      await expect(discover(callerSql!, null, invalidLimit)).rejects.toMatchObject({
        code: '22023',
      });
      await expect(discoverExpiry(callerSql!, null, invalidLimit)).rejects.toMatchObject({
        code: '22023',
      });
    }
    expect(await discover(callerSql!, null, 1000)).toEqual(EXPECTED_ACTIONABLE);
    expect(await discoverExpiry(callerSql!, null, 1000)).toEqual(EXPECTED_EXPIRY_ACTIONABLE);
  });

  it('runs the default expiry discovery path under the production credential boundary', async () => {
    expect(scratch).toBeDefined();
    expect(callerRole).toBeDefined();
    expect(callerPassword).toBeDefined();

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'false',
      ARGON2_SECRET: process.env['ARGON2_SECRET'] ?? 'authoritative-expiry-runner-test-secret',
      BUDGET_CONTROL_DATABASE_URL: roleDatabaseUrl(scratch!.url, callerRole!, callerPassword!),
      CLICKHOUSE_URL: process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123',
      DATABASE_URL: scratch!.url,
      ENABLE_AUTHORITATIVE_BUDGET_CONTROL: 'true',
      EXPECTED_EXPIRY_BUILDERS: EXPECTED_EXPIRY_ACTIONABLE.join(','),
      JWT_PRIVATE_KEY: process.env['JWT_PRIVATE_KEY'] ?? '/tmp/pylva-test-private.pem',
      JWT_PUBLIC_KEY: process.env['JWT_PUBLIC_KEY'] ?? '/tmp/pylva-test-public.pem',
      NODE_ENV: 'production',
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
    };
    for (const name of Object.keys(childEnv)) {
      if (name.startsWith('MIGRATION_')) delete childEnv[name];
    }
    delete childEnv['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN'];

    const { stderr, stdout } = await execFileAsync(
      'pnpm',
      ['exec', 'tsx', 'tests/fixtures/authoritative-budget-expiry-runner.ts'],
      {
        cwd: path.resolve(__dirname, '../..'),
        env: childEnv,
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
    expect(stderr).toBe('');
    expect(stdout).toContain('AUTHORITATIVE_EXPIRY_RUNNER_OK');
  });

  it('cannot be redirected by tenant GUCs, search_path shadows, SET ROLE, or SQL input', async () => {
    const shadowBuilder = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const rows = (await callerSql!.begin(async (transaction) => {
      await transaction.unsafe('SET LOCAL search_path = pg_temp, public');
      await transaction`
        SELECT pg_catalog.set_config(
          'app.builder_id',
          ${BUILDER_IDS.activeProcessing}::UUID::TEXT,
          TRUE
        )
      `;
      await transaction.unsafe(`
        CREATE TEMPORARY TABLE budget_cost_event_outbox (
          builder_id UUID PRIMARY KEY
        ) ON COMMIT DROP
      `);
      await transaction`
        INSERT INTO budget_cost_event_outbox (builder_id)
        VALUES (${shadowBuilder}::UUID)
      `;
      await transaction.unsafe(`
        CREATE TEMPORARY TABLE budget_reservations (
          builder_id UUID PRIMARY KEY
        ) ON COMMIT DROP
      `);
      await transaction`
        INSERT INTO budget_reservations (builder_id)
        VALUES (${shadowBuilder}::UUID)
      `;
      return Promise.all([
        discover(transaction, null, 1000),
        discoverExpiry(transaction, null, 1000),
      ]);
    })) as [string[], string[]];
    expect(rows).toEqual([EXPECTED_ACTIONABLE, EXPECTED_EXPIRY_ACTIONABLE]);

    await expect(
      callerSql!.unsafe(`SET ROLE ${quoteIdentifier(DISCOVERY_OWNER)}`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      callerSql!.unsafe(`SET ROLE ${quoteIdentifier(EXPIRY_OWNER)}`),
    ).rejects.toMatchObject({ code: '42501' });

    const injection = `${BUILDER_IDS.pending}'; DROP TABLE public.builders; --`;
    await expect(
      callerSql!`
        SELECT builder_id
        FROM public.pylva_budget_projection_actionable_builders(
          ${injection}::UUID,
          10
        )
      `,
    ).rejects.toMatchObject({ code: '22P02' });
    const [buildersStillExist] = await db()<{ relation: string | null }[]>`
      SELECT pg_catalog.to_regclass('public.builders')::TEXT AS relation
    `;
    expect(buildersStillExist?.relation).toBe('builders');

    expect(scratch).toBeDefined();
    expect(callerRole).toBeDefined();
    expect(callerPassword).toBeDefined();
    const hostileSql = postgres(roleDatabaseUrl(scratch!.url, callerRole!, callerPassword!), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const [absent] = await hostileSql<{ builder_setting: string | null }[]>`
        SELECT pg_catalog.current_setting(
          'app.builder_id', TRUE
        ) AS builder_setting
      `;
      expect(absent?.builder_setting).toBeNull();
      expect(await discover(hostileSql, null, 1000)).toEqual(EXPECTED_ACTIONABLE);
      expect(await discoverExpiry(hostileSql, null, 1000)).toEqual(EXPECTED_EXPIRY_ACTIONABLE);

      await hostileSql.begin(async (transaction) => {
        await useBuilder(transaction, BUILDER_IDS.activeProcessing);
      });
      const [restored] = await hostileSql<{ builder_setting: string | null }[]>`
        SELECT pg_catalog.current_setting(
          'app.builder_id', TRUE
        ) AS builder_setting
      `;
      expect(restored?.builder_setting).toBe('');
      expect(await discover(hostileSql, null, 1000)).toEqual(EXPECTED_ACTIONABLE);
      expect(await discoverExpiry(hostileSql, null, 1000)).toEqual(EXPECTED_EXPIRY_ACTIONABLE);

      for (const hostileBuilderGuc of ['', 'malformed-not-a-uuid']) {
        const hostileRows = await hostileSql.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.set_config(
              'app.builder_id',
              ${hostileBuilderGuc},
              TRUE
            )
          `;
          return Promise.all([
            discover(transaction, null, 1000),
            discoverExpiry(transaction, null, 1000),
          ]);
        });
        expect(hostileRows).toEqual([EXPECTED_ACTIONABLE, EXPECTED_EXPIRY_ACTIONABLE]);
      }
    } finally {
      await hostileSql.end();
    }
  });

  it('serves concurrent discovery calls without mutating outbox or reservation state', async () => {
    const [before, reservationsBefore] = await Promise.all([
      stateFingerprint('budget_cost_event_outbox'),
      stateFingerprint('budget_reservations'),
    ]);
    const [projectionPages, expiryPages] = await Promise.all([
      Promise.all(Array.from({ length: 32 }, () => discover(callerSql!, null, 1000))),
      Promise.all(Array.from({ length: 32 }, () => discoverExpiry(callerSql!, null, 1000))),
    ]);
    expect(projectionPages.every((page) => page.join(',') === EXPECTED_ACTIONABLE.join(','))).toBe(
      true,
    );
    expect(
      expiryPages.every((page) => page.join(',') === EXPECTED_EXPIRY_ACTIONABLE.join(',')),
    ).toBe(true);

    const [after, reservationsAfter] = await Promise.all([
      stateFingerprint('budget_cost_event_outbox'),
      stateFingerprint('budget_reservations'),
    ]);
    expect(after).toEqual(before);
    expect(reservationsAfter).toEqual(reservationsBefore);
  });
});
