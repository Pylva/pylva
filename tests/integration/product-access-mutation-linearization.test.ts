import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { resolveBuilderEntitlement } from '@pylva/shared';
import { createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const BUILDER_ID = '00000000-0000-0000-0000-000000000001';

let scratch: ScratchDb | undefined;
let lifecycleClient: Sql | undefined;
let mutationClient: Sql | undefined;

function requiredClient(client: Sql | undefined): Sql {
  if (!client) throw new Error('linearization scratch client is unavailable');
  return client;
}

async function lifecycleLockedInsert(
  sql: Sql,
  pauseAfterCheck?: () => Promise<void>,
): Promise<'inserted' | 'access_denied'> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      {
        plan: unknown;
        access_state: unknown;
        entitlement_source: unknown;
      }[]
    >`
      SELECT
        tier AS plan,
        access_state,
        entitlement_source
      FROM builders
      WHERE id = ${BUILDER_ID}::UUID
      FOR SHARE
    `;
    const row = rows[0];
    const resolution = row ? resolveBuilderEntitlement(row) : null;
    if (resolution === null || !resolution.ok || !resolution.entitlement.has_product_access) {
      return 'access_denied';
    }

    await pauseAfterCheck?.();
    await tx`
      INSERT INTO anomaly_events (id, builder_id)
      VALUES ('anomaly-a', ${BUILDER_ID}::UUID)
    `;
    return 'inserted';
  });
}

async function lifecycleLockedDelivery(
  sql: Sql,
  outbound: () => Promise<void>,
): Promise<'delivered' | 'access_denied'> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      {
        plan: unknown;
        access_state: unknown;
        entitlement_source: unknown;
      }[]
    >`
      SELECT
        tier AS plan,
        access_state,
        entitlement_source
      FROM builders
      WHERE id = ${BUILDER_ID}::UUID
      FOR SHARE
    `;
    const row = rows[0];
    const resolution = row ? resolveBuilderEntitlement(row) : null;
    if (resolution === null || !resolution.ok || !resolution.entitlement.has_product_access) {
      return 'access_denied';
    }

    // This is the database shape used by every live channel attempt:
    // authorization and one outbound side effect share the same transaction.
    await outbound();
    return 'delivered';
  });
}

async function backendPid(sql: Sql): Promise<number> {
  const rows = await sql<{ pid: number }[]>`SELECT pg_backend_pid()::INT AS pid`;
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('PostgreSQL backend PID is unavailable');
  return pid;
}

async function waitUntilBlocked(blockedPid: number, blockerPid: number): Promise<void> {
  if (!scratch) throw new Error('linearization scratch database is unavailable');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await scratch.sql<{ blocked: boolean }[]>`
      SELECT ${blockerPid}::INT = ANY(pg_blocking_pids(${blockedPid}::INT)) AS blocked
    `;
    if (rows[0]?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`backend ${blockedPid} never waited for lifecycle blocker ${blockerPid}`);
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'product_access_linearization' });
  await scratch.sql.unsafe(`
    CREATE TABLE builders (
      id UUID PRIMARY KEY,
      tier VARCHAR(32),
      access_state VARCHAR(32) NOT NULL,
      entitlement_source VARCHAR(32)
    );
    CREATE TABLE anomaly_events (
      id TEXT PRIMARY KEY,
      builder_id UUID NOT NULL REFERENCES builders(id)
    );
  `);
  lifecycleClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
  mutationClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
});

beforeEach(async () => {
  if (!scratch) throw new Error('linearization scratch database is unavailable');
  await scratch.sql`TRUNCATE anomaly_events`;
  await scratch.sql`TRUNCATE builders CASCADE`;
  await scratch.sql`
    INSERT INTO builders (id, tier, access_state, entitlement_source)
    VALUES (${BUILDER_ID}::UUID, 'pro', 'active', 'stripe')
  `;
});

afterAll(async () => {
  await lifecycleClient?.end();
  await mutationClient?.end();
  await scratch?.drop();
  scratch = undefined;
});

describe('product-access mutation PostgreSQL linearization', () => {
  it('makes suspension wait until an in-flight outbound alert attempt finishes', async () => {
    let finishOutbound!: () => void;
    let signalOutboundStarted!: () => void;
    const outboundStarted = new Promise<void>((resolve) => {
      signalOutboundStarted = resolve;
    });
    const outboundPaused = new Promise<void>((resolve) => {
      finishOutbound = resolve;
    });
    const deliveryPid = await backendPid(requiredClient(mutationClient));
    const suspensionPid = await backendPid(requiredClient(lifecycleClient));
    let outboundCalls = 0;
    let suspensionCommitted = false;

    const delivery = lifecycleLockedDelivery(requiredClient(mutationClient), async () => {
      outboundCalls += 1;
      signalOutboundStarted();
      await outboundPaused;
    });
    await outboundStarted;

    const suspension = requiredClient(lifecycleClient)`
      UPDATE builders
      SET tier = NULL,
          access_state = 'suspended',
          entitlement_source = 'stripe'
      WHERE id = ${BUILDER_ID}::UUID
    `.then(() => {
      suspensionCommitted = true;
    });

    await waitUntilBlocked(suspensionPid, deliveryPid);
    expect(suspensionCommitted).toBe(false);
    expect(outboundCalls).toBe(1);

    finishOutbound();
    await expect(delivery).resolves.toBe('delivered');
    await suspension;
    expect(suspensionCommitted).toBe(true);
  });

  it('sends no alert when suspension wins before the outbound attempt lock', async () => {
    let commitSuspension!: () => void;
    let signalSuspensionUpdated!: () => void;
    const suspensionUpdated = new Promise<void>((resolve) => {
      signalSuspensionUpdated = resolve;
    });
    const suspensionPaused = new Promise<void>((resolve) => {
      commitSuspension = resolve;
    });
    const suspensionPid = await backendPid(requiredClient(lifecycleClient));
    const deliveryPid = await backendPid(requiredClient(mutationClient));
    let outboundCalls = 0;

    const suspension = requiredClient(lifecycleClient).begin(async (tx) => {
      await tx`
        UPDATE builders
        SET tier = NULL,
            access_state = 'suspended',
            entitlement_source = 'stripe'
        WHERE id = ${BUILDER_ID}::UUID
      `;
      signalSuspensionUpdated();
      await suspensionPaused;
    });
    await suspensionUpdated;

    const delivery = lifecycleLockedDelivery(requiredClient(mutationClient), async () => {
      outboundCalls += 1;
    });
    await waitUntilBlocked(deliveryPid, suspensionPid);
    expect(outboundCalls).toBe(0);

    commitSuspension();
    await suspension;
    await expect(delivery).resolves.toBe('access_denied');
    expect(outboundCalls).toBe(0);
  });

  it('blocks suspension while an allowed mutation holds the lifecycle share lock', async () => {
    let resumeMutation!: () => void;
    let signalAllowedCheckpoint!: () => void;
    const allowedCheckpoint = new Promise<void>((resolve) => {
      signalAllowedCheckpoint = resolve;
    });
    const pausedMutation = new Promise<void>((resolve) => {
      resumeMutation = resolve;
    });

    const mutation = lifecycleLockedInsert(requiredClient(mutationClient), async () => {
      signalAllowedCheckpoint();
      await pausedMutation;
    });
    await allowedCheckpoint;

    await expect(
      requiredClient(lifecycleClient).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '100ms'`);
        await tx`
          UPDATE builders
          SET tier = NULL,
              access_state = 'suspended',
              entitlement_source = 'stripe'
          WHERE id = ${BUILDER_ID}::UUID
        `;
      }),
    ).rejects.toMatchObject({ code: '55P03' });

    resumeMutation();
    await expect(mutation).resolves.toBe('inserted');
    await requiredClient(lifecycleClient)`
      UPDATE builders
      SET tier = NULL,
          access_state = 'suspended',
          entitlement_source = 'stripe'
      WHERE id = ${BUILDER_ID}::UUID
    `;

    await expect(
      requiredClient(lifecycleClient)<{ count: string }[]>`
        SELECT count(*)::TEXT AS count FROM anomaly_events
      `,
    ).resolves.toEqual([{ count: '1' }]);
  });

  it('waits behind an in-flight suspension and denies the mutation after it commits', async () => {
    let commitSuspension!: () => void;
    let signalSuspensionUpdated!: () => void;
    const suspensionUpdated = new Promise<void>((resolve) => {
      signalSuspensionUpdated = resolve;
    });
    const pausedSuspension = new Promise<void>((resolve) => {
      commitSuspension = resolve;
    });

    const suspension = requiredClient(lifecycleClient).begin(async (tx) => {
      await tx`
        UPDATE builders
        SET tier = NULL,
            access_state = 'suspended',
            entitlement_source = 'stripe'
        WHERE id = ${BUILDER_ID}::UUID
      `;
      signalSuspensionUpdated();
      await pausedSuspension;
    });
    await suspensionUpdated;

    await expect(
      requiredClient(mutationClient).begin(async (tx) => {
        await tx.unsafe(`SET LOCAL lock_timeout = '100ms'`);
        await tx`
          SELECT tier, access_state, entitlement_source
          FROM builders
          WHERE id = ${BUILDER_ID}::UUID
          FOR SHARE
        `;
      }),
    ).rejects.toMatchObject({ code: '55P03' });

    commitSuspension();
    await suspension;
    await expect(lifecycleLockedInsert(requiredClient(mutationClient))).resolves.toBe(
      'access_denied',
    );
    await expect(
      requiredClient(mutationClient)<{ count: string }[]>`
        SELECT count(*)::TEXT AS count FROM anomaly_events
      `,
    ).resolves.toEqual([{ count: '0' }]);
  });
});
