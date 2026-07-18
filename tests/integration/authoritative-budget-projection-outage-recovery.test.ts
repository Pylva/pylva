import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';
import { pgJsonbParameterText } from '../../src/lib/budget-control/transaction.js';
import {
  createBudgetProjectionTarget,
  type BudgetProjectionClickHouseClient,
  type BudgetProjectionTarget,
} from '../../src/lib/budget-projection/clickhouse.js';
import {
  createBudgetProjectionPostgresStore,
  createBudgetProjectionWorkerId,
  type BudgetProjectionPostgresStore,
} from '../../src/lib/budget-projection/postgres.js';
import { __budgetProjectionWorkerTesting } from '../../src/lib/budget-projection/worker.js';
import { toolPayload } from '../budget-projection/fixtures.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const baseClickHouseUrl = process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123';
const clickHouseDatabase = `pylva_projection_outage_${crypto.randomBytes(6).toString('hex')}`;

interface OutboxFixture {
  builderId: string;
  eventId: string;
  outboxId: string;
  payloadHash: string;
}

let scratch: ScratchDb | undefined;
let store: BudgetProjectionPostgresStore;
let clickHouseAdmin: ClickHouseClient | undefined;
let liveClickHouse: ClickHouseClient | undefined;
let downClickHouse: ClickHouseClient | undefined;
let liveTarget: BudgetProjectionTarget;
let downTarget: BudgetProjectionTarget;

function db(): Sql {
  if (!scratch) throw new Error('projection outage scratch database is unavailable');
  return scratch.sql;
}

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function unreachableClickHouseUrl(): string {
  const url = new URL(baseClickHouseUrl);
  url.hostname = '127.0.0.1';
  // Port 1 is reserved and has no ClickHouse listener in the test topology.
  url.port = '1';
  url.pathname = `/${clickHouseDatabase}`;
  url.username = '';
  url.password = '';
  return url.toString();
}

async function applyClickHouseMigrations(client: ClickHouseClient): Promise<void> {
  const directory = path.resolve('db/clickhouse');
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const ddl = await fs.readFile(path.join(directory, file), 'utf8');
    for (const query of splitClickHouseStatements(ddl)) await client.command({ query });
  }
}

async function useBuilder(transaction: TransactionSql, builderId: string): Promise<void> {
  await transaction`
    SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
  `;
}

async function seedOutbox(): Promise<OutboxFixture> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [builder] = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`projection-outage-${suffix}@example.com`},
      'Projection outage recovery',
      'pro',
      ${`projection-outage-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  if (!builder?.id) throw new Error('projection outage builder insert failed');

  const builderId = builder.id;
  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const payload = toolPayload({
    builder_id: builderId,
    event_id: eventId,
    reservation_decision_id: crypto.randomUUID(),
    operation_id: crypto.randomUUID(),
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    customer_id: `${builderId}:outage_customer`,
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
      ) VALUES (
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
  const [row] = await db().begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    return transaction<{ payload_hash: string }[]>`
      SELECT payload_hash::TEXT AS payload_hash
      FROM public.budget_cost_event_outbox
      WHERE builder_id = ${builderId}::UUID AND id = ${outboxId}::UUID
    `;
  });
  if (!row?.payload_hash) throw new Error('projection outage payload hash was not stamped');
  return { builderId, eventId, outboxId, payloadHash: row.payload_hash };
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'projection_outage_recovery' });
  try {
    await applyMigrationsThrough(scratch, '051');
    // This suite isolates projection recovery. The complete reservation and
    // retention parent graph is exercised by the lifecycle integration suite.
    await db()`
      ALTER TABLE public.budget_cost_event_outbox
      DROP CONSTRAINT budget_cost_event_outbox_usage_fk
    `;
    await db()`
      ALTER TABLE public.budget_cost_event_outbox
      DISABLE TRIGGER budget_cost_event_outbox_retention_pair_guard
    `;
    store = createBudgetProjectionPostgresStore(db());

    clickHouseAdmin = createClient({ url: baseClickHouseUrl, request_timeout: 30_000 });
    await clickHouseAdmin.command({ query: `CREATE DATABASE ${clickHouseDatabase}` });
    liveClickHouse = createClient({
      url: databaseUrl(baseClickHouseUrl, clickHouseDatabase),
      request_timeout: 30_000,
    });
    await applyClickHouseMigrations(liveClickHouse);
    liveTarget = createBudgetProjectionTarget(
      liveClickHouse as unknown as BudgetProjectionClickHouseClient,
      10_000,
    );

    downClickHouse = createClient({
      url: unreachableClickHouseUrl(),
      request_timeout: 1_000,
      max_open_connections: 1,
      log: { level: ClickHouseLogLevel.OFF },
    });
    downTarget = createBudgetProjectionTarget(
      downClickHouse as unknown as BudgetProjectionClickHouseClient,
      1_000,
    );
  } catch (error) {
    await downClickHouse?.close().catch(() => undefined);
    await liveClickHouse?.close().catch(() => undefined);
    await clickHouseAdmin
      ?.command({ query: `DROP DATABASE IF EXISTS ${clickHouseDatabase}` })
      .catch(() => undefined);
    await clickHouseAdmin?.close().catch(() => undefined);
    await scratch.drop().catch(() => undefined);
    scratch = undefined;
    throw error;
  }
}, 120_000);

afterAll(async () => {
  await downClickHouse?.close().catch(() => undefined);
  await liveClickHouse?.close().catch(() => undefined);
  await clickHouseAdmin
    ?.command({ query: `DROP DATABASE IF EXISTS ${clickHouseDatabase}` })
    .catch(() => undefined);
  await clickHouseAdmin?.close().catch(() => undefined);
  await scratch?.drop().catch(() => undefined);
  scratch = undefined;
});

describe('authoritative projection real outage and recovery', () => {
  it('preserves PostgreSQL authority while ClickHouse is down, then verifies and opens billing', async () => {
    const fixture = await seedOutbox();
    const cutoff = new Date(Date.now() - 1_000).toISOString();
    const [firstLease] = await store.claim(fixture.builderId, createBudgetProjectionWorkerId(), 1);
    expect(firstLease).toMatchObject({
      attempt: 1,
      builder_id: fixture.builderId,
      event_id: fixture.eventId,
      outbox_id: fixture.outboxId,
      payload_hash: fixture.payloadHash,
    });

    await expect(
      __budgetProjectionWorkerTesting.processLease(store, downTarget, firstLease!),
    ).resolves.toBe('retry');
    await expect(
      liveTarget.inspect(fixture.builderId, fixture.eventId, fixture.payloadHash),
    ).resolves.toEqual({ state: 'missing', physical_rows: 0, logical_rows: 0, hashes: [] });

    const [retryEvidence] = await db().begin(async (transaction) => {
      await useBuilder(transaction, fixture.builderId);
      return transaction<
        {
          attempts: number;
          available_at: string;
          last_attempt_at: string;
          last_error_code: string;
          last_error_message: string;
          lock_owner: string | null;
          status: string;
        }[]
      >`
        SELECT attempts,
               public.pylva_budget_timestamp_text(available_at) AS available_at,
               public.pylva_budget_timestamp_text(last_attempt_at) AS last_attempt_at,
               last_error_code,
               last_error_message,
               lock_owner,
               status
        FROM public.budget_cost_event_outbox
        WHERE builder_id = ${fixture.builderId}::UUID
          AND id = ${fixture.outboxId}::UUID
      `;
    });
    expect(retryEvidence).toMatchObject({
      attempts: 1,
      last_error_code: 'PROJECTION_INSPECTION_FAILED',
      lock_owner: null,
      status: 'pending',
    });
    expect(retryEvidence!.last_error_message).toMatch(
      /^Authoritative analytics projection failed \([A-Za-z]*Error\)$/,
    );
    expect(retryEvidence!.last_error_message.length).toBeLessThanOrEqual(1_000);
    expect(retryEvidence!.last_error_message).not.toContain('127.0.0.1');
    expect(retryEvidence!.last_error_message).not.toContain(fixture.builderId);
    expect(retryEvidence!.last_error_message).not.toContain(fixture.eventId);
    expect(Date.parse(retryEvidence!.available_at)).toBeGreaterThan(
      Date.parse(retryEvidence!.last_attempt_at),
    );
    expect(await store.billingGate(fixture.builderId, cutoff)).toEqual({
      closed: true,
      verified: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const [secondLease] = await store.claim(fixture.builderId, createBudgetProjectionWorkerId(), 1);
    expect(secondLease).toMatchObject({
      attempt: 2,
      event_id: fixture.eventId,
      outbox_id: fixture.outboxId,
    });
    await expect(
      __budgetProjectionWorkerTesting.processLease(store, liveTarget, secondLease!),
    ).resolves.toBe('projected');
    await expect(
      liveTarget.inspect(fixture.builderId, fixture.eventId, fixture.payloadHash),
    ).resolves.toEqual({
      state: 'matched',
      physical_rows: 1,
      logical_rows: 1,
      hashes: [fixture.payloadHash],
    });

    const reconciliationItems = await store.listReconciliationItems(fixture.builderId, null, 10);
    expect(reconciliationItems).toEqual([
      {
        builder_id: fixture.builderId,
        event_id: fixture.eventId,
        outbox_id: fixture.outboxId,
        payload_hash: fixture.payloadHash,
      },
    ]);
    await expect(
      __budgetProjectionWorkerTesting.reconcileItem(store, liveTarget, reconciliationItems[0]!),
    ).resolves.toBe('verified');
    await expect(store.status(fixture.builderId)).resolves.toMatchObject({
      caught_up: true,
      pending: 0,
      processing: 0,
      projected_unverified: 0,
      projected_verified: 1,
    });
    await expect(store.billingGate(fixture.builderId, cutoff)).resolves.toEqual({
      closed: true,
      verified: true,
    });
  }, 60_000);
});
