import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ClickHouseLogLevel, createClient, type ClickHouseClient } from '@clickhouse/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';
import {
  createBudgetProjectionTarget,
  type BudgetProjectionClickHouseClient,
  type BudgetProjectionTarget,
} from '../../src/lib/budget-projection/clickhouse.js';
import {
  attestBudgetProjectionClickHouse,
  type BudgetProjectionClickHousePostureClient,
} from '../../src/lib/budget-projection/clickhouse-posture.js';
import {
  BUDGET_PROJECTION_CLICKHOUSE_ROLE,
  GENERAL_CLICKHOUSE_APP_ROLE,
} from '../../src/lib/budget-projection/clickhouse-config.js';
import { provisionAuthoritativeBudgetClickHouseRbac } from '../../scripts/provision-authoritative-budget-clickhouse-rbac.js';
import { toolPayload } from '../budget-projection/fixtures.js';

const baseUrl = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';
const suffix = crypto.randomBytes(6).toString('hex');
const database = `pylva_budget_rbac_${suffix}`;
const projectorRole = BUDGET_PROJECTION_CLICKHOUSE_ROLE;
const projectorUsername = `pylva_budget_projector_${suffix}`;
const projectorPassword = crypto.randomBytes(24).toString('hex');
const generalRole = GENERAL_CLICKHOUSE_APP_ROLE;
const generalUsername = `pylva_general_app_${suffix}`;
const generalPassword = crypto.randomBytes(24).toString('hex');
const hostileUsername = `pylva_hostile_app_${suffix}`;
const hostilePassword = crypto.randomBytes(24).toString('hex');
const inheritedHostileUsername = `pylva_inherited_hostile_${suffix}`;
const inheritedHostilePassword = crypto.randomBytes(24).toString('hex');
const columnHostileUsername = `pylva_column_hostile_${suffix}`;
const columnHostilePassword = crypto.randomBytes(24).toString('hex');
const hostileRole = `pylva_hostile_writer_${suffix}`;

let admin: ClickHouseClient;
let projector: ClickHouseClient;
let general: ClickHouseClient;
let projectorTarget: BudgetProjectionTarget;
let generalTarget: BudgetProjectionTarget;

async function applyRbacPlan(): Promise<void> {
  await provisionAuthoritativeBudgetClickHouseRbac(
    {
      CLICKHOUSE_ADMIN_URL: baseUrl,
      CLICKHOUSE_URL: databaseUrl(generalUsername, generalPassword),
      BUDGET_PROJECTION_CLICKHOUSE_URL: databaseUrl(projectorUsername, projectorPassword),
    },
    { allowInsecureLoopbackForTests: true },
  );
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseUrl(username: string, password: string): string {
  const url = new URL(baseUrl);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function applyClickHouseMigrations(client: ClickHouseClient): Promise<void> {
  const directory = path.resolve('db/clickhouse');
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const ddl = await fs.readFile(path.join(directory, file), 'utf8');
    for (const query of splitClickHouseStatements(ddl)) {
      await client.command({ query });
    }
  }
}

beforeAll(async () => {
  const db = quoteIdentifier(database);
  admin = createClient({ url: baseUrl, request_timeout: 30_000 });
  await admin.command({ query: `CREATE DATABASE ${db}` });
  const migrationClient = createClient({
    url: (() => {
      const url = new URL(baseUrl);
      url.pathname = `/${database}`;
      return url.toString();
    })(),
    request_timeout: 30_000,
  });
  try {
    await applyClickHouseMigrations(migrationClient);
  } finally {
    await migrationClient.close();
  }

  await admin.command({
    query: `CREATE USER ${quoteIdentifier(projectorUsername)} IDENTIFIED WITH sha256_password BY '${projectorPassword}'`,
  });
  await admin.command({
    query: `CREATE USER ${quoteIdentifier(generalUsername)} IDENTIFIED WITH sha256_password BY '${generalPassword}'`,
  });

  await applyRbacPlan();

  projector = createClient({
    url: databaseUrl(projectorUsername, projectorPassword),
    request_timeout: 30_000,
    log: { level: ClickHouseLogLevel.OFF },
  });
  general = createClient({
    url: databaseUrl(generalUsername, generalPassword),
    request_timeout: 30_000,
    log: { level: ClickHouseLogLevel.OFF },
  });
  projectorTarget = createBudgetProjectionTarget(
    projector as unknown as BudgetProjectionClickHouseClient,
    10_000,
  );
  generalTarget = createBudgetProjectionTarget(
    general as unknown as BudgetProjectionClickHouseClient,
    10_000,
  );
}, 60_000);

afterAll(async () => {
  await projector?.close().catch(() => undefined);
  await general?.close().catch(() => undefined);
  await admin
    ?.command({ query: `DROP USER IF EXISTS ${quoteIdentifier(projectorUsername)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP USER IF EXISTS ${quoteIdentifier(generalUsername)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP USER IF EXISTS ${quoteIdentifier(hostileUsername)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP USER IF EXISTS ${quoteIdentifier(inheritedHostileUsername)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP USER IF EXISTS ${quoteIdentifier(columnHostileUsername)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP ROLE IF EXISTS ${quoteIdentifier(hostileRole)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP ROLE IF EXISTS ${quoteIdentifier(projectorRole)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP ROLE IF EXISTS ${quoteIdentifier(generalRole)}` })
    .catch(() => undefined);
  await admin
    ?.command({ query: `DROP DATABASE IF EXISTS ${quoteIdentifier(database)}` })
    .catch(() => undefined);
  await admin?.close().catch(() => undefined);
});

describe('authoritative ClickHouse projector credential boundary', () => {
  it('passes the production effective-grant posture with real ClickHouse roles', async () => {
    await expect(
      attestBudgetProjectionClickHouse(
        projector as unknown as BudgetProjectionClickHousePostureClient,
        general as unknown as BudgetProjectionClickHousePostureClient,
        {
          database,
          expectedGeneralRole: generalRole,
          expectedGeneralUsername: generalUsername,
          expectedProjectorRole: projectorRole,
          expectedProjectorUsername: projectorUsername,
        },
      ),
    ).resolves.toBeNull();
  });

  it('idempotently removes inherited, direct, global, and selective privilege drift', async () => {
    const db = quoteIdentifier(database);
    await admin.command({
      query: `CREATE USER ${quoteIdentifier(hostileUsername)} IDENTIFIED WITH sha256_password BY '${hostilePassword}'`,
    });
    await admin.command({ query: `CREATE ROLE ${quoteIdentifier(hostileRole)}` });
    await admin.command({
      query: `CREATE USER ${quoteIdentifier(inheritedHostileUsername)} IDENTIFIED WITH sha256_password BY '${inheritedHostilePassword}'`,
    });
    await admin.command({
      query: `GRANT ${quoteIdentifier(projectorRole)} TO ${quoteIdentifier(hostileUsername)}`,
    });
    await admin.command({
      query: `GRANT INSERT ON ${db}."budget_cost_events" TO ${quoteIdentifier(hostileUsername)}`,
    });
    await admin.command({
      query: `GRANT INSERT ON *.* TO ${quoteIdentifier(hostileRole)}`,
    });
    await admin.command({
      query: `GRANT ${quoteIdentifier(hostileRole)} TO ${quoteIdentifier(inheritedHostileUsername)}`,
    });
    await admin.command({
      query: `SET DEFAULT ROLE ${quoteIdentifier(hostileRole)} TO ${quoteIdentifier(inheritedHostileUsername)}`,
    });
    await admin.command({
      query: `GRANT ALTER UPDATE ON ${db}."budget_cost_events" TO ${quoteIdentifier(projectorRole)}`,
    });
    await admin.command({
      query: `GRANT SYSTEM FLUSH LOGS ON *.* TO ${quoteIdentifier(projectorUsername)}`,
    });
    await expect(
      attestBudgetProjectionClickHouse(
        projector as unknown as BudgetProjectionClickHousePostureClient,
        general as unknown as BudgetProjectionClickHousePostureClient,
        {
          database,
          expectedGeneralRole: generalRole,
          expectedGeneralUsername: generalUsername,
          expectedProjectorRole: projectorRole,
          expectedProjectorUsername: projectorUsername,
        },
      ),
    ).resolves.toBe('projector_role_contract_invalid');

    await applyRbacPlan();
    await admin.command({
      query: `GRANT ALTER DELETE ON ${db}."budget_cost_events" TO ${quoteIdentifier(generalRole)}`,
    });
    await expect(
      attestBudgetProjectionClickHouse(
        projector as unknown as BudgetProjectionClickHousePostureClient,
        general as unknown as BudgetProjectionClickHousePostureClient,
        {
          database,
          expectedGeneralRole: generalRole,
          expectedGeneralUsername: generalUsername,
          expectedProjectorRole: projectorRole,
          expectedProjectorUsername: projectorUsername,
        },
      ),
    ).resolves.toBe('general_effective_grants_mismatch');

    await applyRbacPlan();
    await applyRbacPlan();
    await expect(
      attestBudgetProjectionClickHouse(
        projector as unknown as BudgetProjectionClickHousePostureClient,
        general as unknown as BudgetProjectionClickHousePostureClient,
        {
          database,
          expectedGeneralRole: generalRole,
          expectedGeneralUsername: generalUsername,
          expectedProjectorRole: projectorRole,
          expectedProjectorUsername: projectorUsername,
        },
      ),
    ).resolves.toBeNull();

    const assignments = await admin.query({
      query: `SELECT user_name, granted_role_name
              FROM system.role_grants
              WHERE granted_role_name IN {roles:Array(String)}
              ORDER BY granted_role_name`,
      query_params: { roles: [projectorRole, generalRole] },
      format: 'JSONEachRow',
    });
    await expect(assignments.json()).resolves.toEqual([
      { user_name: projectorUsername, granted_role_name: projectorRole },
      { user_name: generalUsername, granted_role_name: generalRole },
    ]);

    const directHostile = createClient({
      url: databaseUrl(hostileUsername, hostilePassword),
      request_timeout: 30_000,
      log: { level: ClickHouseLogLevel.OFF },
    });
    const inheritedHostile = createClient({
      url: databaseUrl(inheritedHostileUsername, inheritedHostilePassword),
      request_timeout: 30_000,
      log: { level: ClickHouseLogLevel.OFF },
    });
    try {
      const payload = toolPayload({
        builder_id: crypto.randomUUID(),
        event_id: crypto.randomUUID(),
        reservation_decision_id: crypto.randomUUID(),
        operation_id: crypto.randomUUID(),
        trace_id: crypto.randomUUID(),
        span_id: crypto.randomUUID(),
      });
      await expect(
        createBudgetProjectionTarget(
          directHostile as unknown as BudgetProjectionClickHouseClient,
        ).insert(payload, 'c'.repeat(64)),
      ).rejects.toMatchObject({ code: '497' });
      await expect(
        createBudgetProjectionTarget(
          inheritedHostile as unknown as BudgetProjectionClickHouseClient,
        ).insert(payload, 'd'.repeat(64)),
      ).rejects.toMatchObject({ code: '497' });
    } finally {
      await Promise.all([directHostile.close(), inheritedHostile.close()]);
    }
    await admin.command({ query: `DROP USER ${quoteIdentifier(hostileUsername)}` });
    await admin.command({ query: `DROP USER ${quoteIdentifier(inheritedHostileUsername)}` });
    await admin.command({ query: `DROP ROLE ${quoteIdentifier(hostileRole)}` });

    await admin.command({
      query: `CREATE USER ${quoteIdentifier(columnHostileUsername)} IDENTIFIED WITH sha256_password BY '${columnHostilePassword}'`,
    });
    await admin.command({
      query: `GRANT INSERT(event_id) ON ${db}."budget_cost_events" TO ${quoteIdentifier(columnHostileUsername)}`,
    });
    await applyRbacPlan();
    const columnHostile = createClient({
      url: databaseUrl(columnHostileUsername, columnHostilePassword),
      request_timeout: 30_000,
      log: { level: ClickHouseLogLevel.OFF },
    });
    try {
      await expect(
        columnHostile.command({
          query: 'INSERT INTO budget_cost_events (event_id) VALUES (generateUUIDv4())',
        }),
      ).rejects.toMatchObject({ code: '497' });
    } finally {
      await columnHostile.close();
    }
    await admin.command({ query: `DROP USER ${quoteIdentifier(columnHostileUsername)}` });
  });

  it('lets only the projector insert and inspect an authoritative event', async () => {
    const builderId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const hash = 'e'.repeat(64);
    const payload = toolPayload({
      builder_id: builderId,
      event_id: eventId,
      reservation_decision_id: crypto.randomUUID(),
      operation_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      customer_id: `${builderId}:rbac`,
    });

    await expect(projectorTarget.insert(payload, hash)).resolves.toBeUndefined();
    await expect(projectorTarget.inspect(builderId, eventId, hash)).resolves.toMatchObject({
      state: 'matched',
      logical_rows: 1,
    });
    await expect(generalTarget.insert(payload, hash)).rejects.toThrow();

    const response = await general.query({
      query: `SELECT event_origin, count() AS event_count
              FROM cost_events_with_control
              WHERE builder_id = {builder:String} AND event_id = {event:UUID}
              GROUP BY event_origin`,
      query_params: { builder: builderId, event: eventId },
      format: 'JSONEachRow',
    });
    const rows = (await response.json()) as Array<{
      event_count: number | string;
      event_origin: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_origin).toBe('authoritative_budget');
    expect(Number(rows[0]?.event_count)).toBe(1);
  });

  it('denies general ALTER UPDATE and ALTER DELETE on authoritative facts', async () => {
    await expect(
      general.command({
        query: `ALTER TABLE budget_cost_events UPDATE status = 'mutated' WHERE 0`,
      }),
    ).rejects.toMatchObject({ code: '497' });
    await expect(
      general.command({ query: 'ALTER TABLE budget_cost_events DELETE WHERE 0' }),
    ).rejects.toMatchObject({ code: '497' });
  });

  it('keeps general legacy ingest while denying it to the isolated projector', async () => {
    const builderId = crypto.randomUUID();
    const legacyRow = {
      timestamp: '2026-07-14 09:10:11',
      builder_id: builderId,
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      parent_span_id: null,
      customer_id: `${builderId}:legacy`,
      provider: 'other',
      model: null,
      operation: 'reported',
      step_name: 'agent.search',
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: '0.001000',
      latency_ms: 1,
      status: 'success',
      cost_source: 'configured',
      instrumentation_tier: 'reported',
      metric: 'request',
      metric_value: 1,
      metadata: '{}',
    };

    await expect(
      general.insert({ table: 'cost_events', values: [legacyRow], format: 'JSONEachRow' }),
    ).resolves.toMatchObject({ executed: true });
    await expect(
      general.command({
        query: `ALTER TABLE cost_events UPDATE
                  cost_usd = toDecimal64(0.002, 6), pricing_status = 'priced'
                WHERE builder_id = {builder:String}`,
        query_params: { builder: builderId },
        clickhouse_settings: { mutations_sync: '1' },
      }),
    ).resolves.toBeDefined();
    await expect(
      projector.insert({ table: 'cost_events', values: [legacyRow], format: 'JSONEachRow' }),
    ).rejects.toThrow();
    await expect(
      projector.command({
        query: `ALTER TABLE cost_events UPDATE status = 'mutated' WHERE 0`,
      }),
    ).rejects.toMatchObject({ code: '497' });
    await expect(
      projector.command({ query: 'ALTER TABLE cost_events DELETE WHERE 0' }),
    ).rejects.toMatchObject({ code: '497' });
    await expect(
      projector.command({ query: 'OPTIMIZE TABLE cost_events FINAL' }),
    ).rejects.toMatchObject({ code: '497' });
  });
});
