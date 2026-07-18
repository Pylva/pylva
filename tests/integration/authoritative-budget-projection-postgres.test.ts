import crypto from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBudgetProjectionPostgresStore,
  createBudgetProjectionWorkerId,
  type BudgetProjectionPostgresStore,
} from '../../src/lib/budget-projection/postgres.js';
import { pgJsonbParameterText } from '../../src/lib/budget-control/transaction.js';
import { toolPayload } from '../budget-projection/fixtures.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

interface Fixture {
  builderId: string;
  eventId: string;
  outboxId: string;
  usageId: string;
}

let scratch: ScratchDb | undefined;
let store: BudgetProjectionPostgresStore;
let raceClient: Sql | undefined;
let raceStore: BudgetProjectionPostgresStore;
let sharedDrizzleClient: Sql | undefined;
let sharedDrizzleStore: BudgetProjectionPostgresStore;

function db(): Sql {
  if (!scratch) throw new Error('projection scratch database is unavailable');
  return scratch.sql;
}

async function useBuilder(transaction: TransactionSql, builderId: string): Promise<void> {
  await transaction`
    SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
  `;
}

async function insertBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(5).toString('hex');
  const rows = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (${`${label}-${suffix}@example.com`}, ${label}, 'pro', ${`${label}-${suffix}`})
    RETURNING id
  `;
  return rows[0]!.id;
}

async function seedOutbox(builderId: string): Promise<Fixture> {
  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const usageId = crypto.randomUUID();
  const payload = toolPayload({
    builder_id: builderId,
    event_id: eventId,
    reservation_decision_id: crypto.randomUUID(),
    operation_id: crypto.randomUUID(),
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    customer_id: `${builderId}:customer_${crypto.randomBytes(3).toString('hex')}`,
  });
  await db().begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    await transaction`
      INSERT INTO public.budget_cost_event_outbox (
        builder_id, id, usage_ledger_id, cost_event_id,
        payload_schema_version, payload, payload_hash
      )
      VALUES (
        ${builderId}::UUID, ${outboxId}::UUID, ${usageId}::UUID, ${eventId}::UUID,
        '1.6',
        ${pgJsonbParameterText(payload as unknown as postgres.JSONValue)}::TEXT::JSONB,
        ${'0'.repeat(64)}
      )
    `;
  });
  return { builderId, eventId, outboxId, usageId };
}

async function outboxRow<T>(
  fixture: Fixture,
  selection: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return db().begin(async (transaction) => {
    await useBuilder(transaction, fixture.builderId);
    return selection(transaction);
  }) as Promise<T>;
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'authoritative_budget_projection' });
  try {
    await applyMigrationsThrough(scratch, '051');
    // Projection lifecycle behavior is the subject of this suite. Fixtures
    // omit the much larger reservation/allocation graph already proven by the
    // lifecycle integration suite; relax only those two fixture relationships
    // in this disposable owner-controlled database. The production outbox
    // immutability/RLS trigger remains enabled throughout every assertion.
    await scratch.sql`
      ALTER TABLE public.budget_cost_event_outbox
      DROP CONSTRAINT budget_cost_event_outbox_usage_fk
    `;
    await scratch.sql`
      ALTER TABLE public.budget_cost_event_outbox
      DISABLE TRIGGER budget_cost_event_outbox_retention_pair_guard
    `;
    store = createBudgetProjectionPostgresStore(scratch.sql);
    raceClient = postgres(scratch.url, { max: 8, onnotice: () => undefined });
    raceStore = createBudgetProjectionPostgresStore(raceClient);
    sharedDrizzleClient = postgres(scratch.url, { max: 4, onnotice: () => undefined });
    const sharedDashboard = drizzle(sharedDrizzleClient);
    await sharedDashboard.execute(drizzleSql`SELECT 1 AS ready`);
    sharedDrizzleStore = createBudgetProjectionPostgresStore(sharedDrizzleClient);
  } catch (error) {
    await sharedDrizzleClient?.end().catch(() => undefined);
    await raceClient?.end().catch(() => undefined);
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
});

afterAll(async () => {
  await sharedDrizzleClient?.end().catch(() => undefined);
  await raceClient?.end().catch(() => undefined);
  await scratch?.drop();
});

describe('authoritative projection PostgreSQL leases', () => {
  it('claims, renews, and projects only with the exact owner/attempt/lease token', async () => {
    const builderId = await insertBuilder('projection-fencing');
    const fixture = await seedOutbox(builderId);
    const worker = createBudgetProjectionWorkerId();
    const [claimed] = await store.claim(builderId, worker, 10);
    expect(claimed).toMatchObject({
      builder_id: builderId,
      outbox_id: fixture.outboxId,
      event_id: fixture.eventId,
      attempt: 1,
      worker_id: worker,
    });

    const renewed = await store.renew(claimed!);
    expect(renewed).not.toBeNull();
    expect(Date.parse(renewed!.lock_expires_at)).toBeGreaterThan(
      Date.parse(claimed!.lock_expires_at),
    );
    expect(await store.renew({ ...renewed!, attempt: 2 })).toBeNull();
    expect(
      await store.renew({
        ...renewed!,
        worker_id: createBudgetProjectionWorkerId(),
      }),
    ).toBeNull();
    expect(await store.markProjected(claimed!)).toBe(false);
    expect(await store.markProjected(renewed!)).toBe(true);

    const rows = await outboxRow(
      fixture,
      (transaction) =>
        transaction<
          Array<{
            attempts: number;
            lock_owner: string | null;
            projected_at: Date | null;
            status: string;
          }>
        >`
        SELECT attempts, lock_owner, projected_at, status
        FROM public.budget_cost_event_outbox
        WHERE builder_id = ${builderId}::UUID AND id = ${fixture.outboxId}::UUID
      `,
    );
    expect(rows[0]).toMatchObject({
      attempts: 1,
      lock_owner: null,
      status: 'projected',
    });
    expect(rows[0]?.projected_at).toBeInstanceOf(Date);
  });

  it('releases with bounded retry evidence and increments attempts only on the next claim', async () => {
    const builderId = await insertBuilder('projection-retry');
    const fixture = await seedOutbox(builderId);
    const worker = createBudgetProjectionWorkerId();
    const [first] = await store.claim(builderId, worker, 1);
    expect(
      await store.releaseForRetry(first!, {
        code: 'CLICKHOUSE_UNAVAILABLE',
        message: 'ClickHouse projection transport was unavailable',
      }),
    ).toBe(true);
    const released = await outboxRow(
      fixture,
      (transaction) =>
        transaction<
          Array<{
            attempts: number;
            available_at: Date;
            last_error_code: string;
            lock_owner: string | null;
            status: string;
          }>
        >`
        SELECT attempts, available_at, last_error_code, lock_owner, status
        FROM public.budget_cost_event_outbox
        WHERE builder_id = ${builderId}::UUID AND id = ${fixture.outboxId}::UUID
      `,
    );
    expect(released[0]).toMatchObject({
      attempts: 1,
      last_error_code: 'CLICKHOUSE_UNAVAILABLE',
      lock_owner: null,
      status: 'pending',
    });
    expect(released[0]!.available_at.getTime()).toBeGreaterThan(Date.now() - 250);
    expect(released[0]!.available_at.getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(await store.claim(builderId, worker, 1)).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const [second] = await store.claim(builderId, worker, 1);
    expect(second?.attempt).toBe(2);
    expect(Date.parse(second!.lock_expires_at) - Date.parse(second!.locked_at)).toBe(60_000);
    expect(second?.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recovers an expired owner with exact stale-lease fencing', async () => {
    const builderId = await insertBuilder('projection-recovery');
    const fixture = await seedOutbox(builderId);
    const firstWorker = createBudgetProjectionWorkerId();
    const [claimed] = await store.claim(builderId, firstWorker, 1);
    expect(claimed).toBeDefined();

    await outboxRow(fixture, async (transaction) => {
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        DISABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await transaction`
        UPDATE public.budget_cost_event_outbox
        SET created_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '3 minutes'),
            updated_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '2 minutes'),
            available_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '3 minutes'),
            locked_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '2 minutes'),
            last_attempt_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '2 minutes'),
            lock_expires_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '1 minute')
        WHERE builder_id = ${builderId}::UUID AND id = ${fixture.outboxId}::UUID
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        ENABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
    });

    const recoveryWorker = createBudgetProjectionWorkerId();
    expect(await store.recoverExpiredLeases(builderId, recoveryWorker, 10)).toBe(1);
    expect(await store.markProjected(claimed!)).toBe(false);
    const [reclaimed] = await store.claim(builderId, recoveryWorker, 1);
    expect(reclaimed).toMatchObject({ attempt: 2, worker_id: recoveryWorker });
  });

  it('keeps claim, renew, and recovery typed after Drizzle mutates the shared client', async () => {
    const builderId = await insertBuilder('projection-shared-drizzle');
    const renewable = await seedOutbox(builderId);
    const expiring = await seedOutbox(builderId);
    const worker = createBudgetProjectionWorkerId();
    const leases = await sharedDrizzleStore.claim(builderId, worker, 2);
    const renewableLease = leases.find((lease) => lease.outbox_id === renewable.outboxId);
    const expiringLease = leases.find((lease) => lease.outbox_id === expiring.outboxId);
    expect(renewableLease).toMatchObject({
      payload: expect.objectContaining({ event_id: renewable.eventId }),
      attempt: 1,
      locked_at: expect.stringMatching(/\.\d{3}Z$/),
      lock_expires_at: expect.stringMatching(/\.\d{3}Z$/),
    });
    expect(expiringLease).toBeDefined();

    const renewed = await sharedDrizzleStore.renew(renewableLease!);
    expect(renewed).toMatchObject({
      payload: expect.objectContaining({ event_id: renewable.eventId }),
      attempt: 1,
    });
    expect(Date.parse(renewed!.lock_expires_at)).toBeGreaterThan(
      Date.parse(renewableLease!.lock_expires_at),
    );

    await outboxRow(expiring, async (transaction) => {
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        DISABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await transaction`
        UPDATE public.budget_cost_event_outbox
        SET created_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '3 minutes'),
            updated_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '1 minute'),
            available_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '3 minutes'),
            locked_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '2 minutes'),
            last_attempt_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '2 minutes'),
            lock_expires_at = date_trunc('milliseconds', statement_timestamp() - INTERVAL '1 minute')
        WHERE builder_id = ${builderId}::UUID AND id = ${expiring.outboxId}::UUID
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        ENABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
    });

    const recoveryWorker = createBudgetProjectionWorkerId();
    expect(await sharedDrizzleStore.recoverExpiredLeases(builderId, recoveryWorker, 10)).toBe(1);
    const [reclaimed] = await sharedDrizzleStore.claim(builderId, recoveryWorker, 10);
    expect(reclaimed).toMatchObject({
      outbox_id: expiring.outboxId,
      attempt: 2,
      payload: expect.objectContaining({ event_id: expiring.eventId }),
    });
  });

  it('gives concurrent workers disjoint claims without crossing tenant context', async () => {
    const builderA = await insertBuilder('projection-concurrent-a');
    const builderB = await insertBuilder('projection-concurrent-b');
    const fixtures = await Promise.all(Array.from({ length: 16 }, () => seedOutbox(builderA)));
    const otherTenant = await seedOutbox(builderB);
    const workerA = createBudgetProjectionWorkerId();
    const workerB = createBudgetProjectionWorkerId();
    const [claimsA, claimsB] = await Promise.all([
      raceStore.claim(builderA, workerA, 16),
      raceStore.claim(builderA, workerB, 16),
    ]);
    const claimedIds = [...claimsA, ...claimsB].map((lease) => lease.outbox_id);
    expect(claimedIds).toHaveLength(fixtures.length);
    expect(new Set(claimedIds).size).toBe(fixtures.length);
    expect(claimedIds.sort()).toEqual(fixtures.map((fixture) => fixture.outboxId).sort());
    expect(claimsA.every((lease) => lease.builder_id === builderA)).toBe(true);
    expect(claimsB.every((lease) => lease.builder_id === builderA)).toBe(true);
    const [tenantBClaim] = await raceStore.claim(builderB, createBudgetProjectionWorkerId(), 5);
    expect(tenantBClaim?.outbox_id).toBe(otherTenant.outboxId);
  });
});

describe('authoritative projection reconciliation and watermark', () => {
  it('keeps billing blocked while a projected identity remains conflicted and unverified', async () => {
    const builderId = await insertBuilder('projection-conflict-gate');
    await seedOutbox(builderId);
    const [lease] = await store.claim(builderId, createBudgetProjectionWorkerId(), 1);
    expect(await store.markProjected(lease!)).toBe(true);

    // A cross-timestamp/hash conflict is detected in ClickHouse by the paired
    // real integration test and deliberately never calls markVerified. The
    // PostgreSQL half of that invariant must retain a visible alarm and block
    // billing for the closed period.
    expect(await store.status(builderId)).toMatchObject({
      projected_unverified: 1,
      caught_up: false,
    });
    expect(await store.billingGate(builderId, '2026-07-14T09:10:12.000Z')).toEqual({
      closed: true,
      verified: false,
    });
  });

  it('marks a projected row verified once and advances the durable gate', async () => {
    const builderId = await insertBuilder('projection-reconciliation');
    const fixture = await seedOutbox(builderId);
    const worker = createBudgetProjectionWorkerId();
    const [lease] = await store.claim(builderId, worker, 1);
    expect(await store.isVerifiedBefore(builderId, '2027-01-01T00:00:00.000Z')).toBe(false);
    expect(await store.billingGate(builderId, '2099-01-01T00:00:00.000Z')).toEqual({
      closed: false,
      verified: false,
    });
    expect(await store.billingGate(builderId, '2026-07-14T09:10:12.000Z')).toEqual({
      closed: true,
      verified: false,
    });
    expect(await store.markProjected(lease!)).toBe(true);
    const [item] = await store.listReconciliationItems(builderId, null, 10);
    expect(item).toMatchObject({
      builder_id: builderId,
      outbox_id: fixture.outboxId,
      event_id: fixture.eventId,
    });
    expect(await Promise.all([store.markVerified(item!), raceStore.markVerified(item!)])).toEqual([
      true,
      true,
    ]);
    expect(await store.markVerified(item!)).toBe(true);
    expect(await store.isVerifiedBefore(builderId, '2027-01-01T00:00:00.000Z')).toBe(true);
    expect(await store.billingGate(builderId, '2026-07-14T09:10:12.000Z')).toEqual({
      closed: true,
      verified: true,
    });
    expect(await store.listReconciliationItems(builderId, null, 10)).toEqual([]);

    // A historically expensive retry that ultimately projected and verified
    // is not an active operator alarm forever.
    await outboxRow(fixture, async (transaction) => {
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        DISABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await transaction`
        UPDATE public.budget_cost_event_outbox
        SET attempts = 100
        WHERE builder_id = ${builderId}::UUID AND id = ${fixture.outboxId}::UUID
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        ENABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
    });

    const status = await store.status(builderId);
    expect(status).toMatchObject({
      pending: 0,
      processing: 0,
      projected_unverified: 0,
      projected_verified: 1,
      high_attempt_rows: 0,
      caught_up: true,
    });
    expect(status.latest_authoritative_event_at).toBe('2026-07-14T09:10:11.123Z');
  });

  it('reports the oldest gap, high-attempt alarm, and finite-attempt exhaustion', async () => {
    const builderId = await insertBuilder('projection-watermark-gap');
    const first = await seedOutbox(builderId);
    await seedOutbox(builderId);
    await outboxRow(first, async (transaction) => {
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        DISABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
      await transaction`
        UPDATE public.budget_cost_event_outbox
        SET attempts = 2147483646,
            last_attempt_at = created_at
        WHERE builder_id = ${builderId}::UUID AND id = ${first.outboxId}::UUID
      `;
      await transaction`
        ALTER TABLE public.budget_cost_event_outbox
        ENABLE TRIGGER budget_cost_event_outbox_immutability_guard
      `;
    });
    const status = await store.status(builderId);
    expect(status).toMatchObject({
      pending: 2,
      high_attempt_rows: 1,
      exhausted_attempt_rows: 1,
      oldest_unverified_event_at: '2026-07-14T09:10:11.123Z',
      contiguous_verified_before: '2026-07-14T09:10:11.123Z',
      caught_up: false,
    });
    const claims = await store.claim(builderId, createBudgetProjectionWorkerId(), 10);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.outbox_id).not.toBe(first.outboxId);
  });
});
