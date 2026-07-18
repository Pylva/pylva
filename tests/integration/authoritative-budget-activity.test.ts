import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drizzleSql } from 'drizzle-orm';
import * as v from 'valibot';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  ReserveUsageRequestSchema,
  type ParsedReserveUsageRequest,
} from '@pylva/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBudgetControlCutover,
  markBudgetControlReady,
} from '../../src/lib/budget-control/readiness.js';
import {
  createReserveBudgetUsage,
  type ResolveReservationPricing,
} from '../../src/lib/budget-control/reservation-service.js';
import { createBudgetLifecycleService } from '../../src/lib/budget-control/lifecycle-service.js';
import {
  getBudgetAccountStateInTransaction,
  listBudgetActivityInTransaction,
} from '../../src/lib/budget-activity/read-model.js';
import { parseBudgetActivityQuery } from '../../src/lib/budget-activity/query.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

type LedgerSql = Sql | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;

interface BuilderRuleFixture {
  builderId: string;
  ruleKey: string;
  limitUsd: string;
}

let scratch: ScratchDb | undefined;
let pool: Sql | undefined;
let dashboardPool: Sql | undefined;

function db(): Sql {
  if (!pool) throw new Error('budget activity scratch database is unavailable');
  return pool;
}

function dashboardDb() {
  if (!dashboardPool) throw new Error('budget activity Drizzle pool is unavailable');
  return drizzle(dashboardPool);
}

async function useBuilder(client: LedgerSql, builderId: string): Promise<void> {
  await client`SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)`;
}

async function jsonHash(client: LedgerSql, input: JsonObject): Promise<string> {
  const rows = await client<{ value: string }[]>`
    SELECT public.pylva_budget_jsonb_sha256(${client.json(input)}::JSONB) AS value
  `;
  const hash = rows[0]?.value;
  if (!hash) throw new Error('fixture canonical JSON hash was unavailable');
  return hash;
}

async function createBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(5).toString('hex');
  const rows = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`${label}-${suffix}@example.com`}, ${label}, 'pro',
      ${`${label}-${suffix}`.toLowerCase()}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error('fixture builder insert returned no identity');
  return id;
}

async function createReadyBuilderWithRule(
  label: string,
  limitUsd: string,
): Promise<BuilderRuleFixture> {
  const builderId = await createBuilder(label);
  await createBudgetControlCutover(builderId, 'exact_backfill', {
    client: db(),
    maxAttempts: 1,
  });
  await markBudgetControlReady(builderId, {
    client: db(),
    maxAttempts: 1,
    activateExactBackfill: async () => undefined,
  });

  const ruleKey = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  await db().begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    await transaction`
      INSERT INTO public.rules (
        id, builder_id, type, enforcement, name, enabled, config, status
      )
      VALUES (
        ${ruleKey}::UUID, ${builderId}::UUID, 'budget_limit', 'pre_call',
        ${`${label} hard stop`}, TRUE,
        ${transaction.json({
          scope: 'pooled',
          period: 'day',
          hard_stop: true,
          limit_usd: Number(limitUsd),
        })}::JSONB,
        'active'
      )
    `;
    const snapshot: JsonObject = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'hard_stop',
      limit_usd: limitUsd,
    };
    const snapshotHash = await jsonHash(transaction, snapshot);
    await transaction`
      INSERT INTO public.budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${revisionId}::UUID, ${ruleKey}::UUID, 0,
        'pooled', NULL, 'day', 'hard_stop', ${limitUsd}::NUMERIC,
        ${transaction.json(snapshot)}::JSONB, ${snapshotHash}
      )
    `;
  });
  return { builderId, ruleKey, limitUsd };
}

function toolRequest(customerId: string): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: crypto.randomUUID(),
    customer_id: customerId,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'search_knowledge',
    framework: 'langgraph',
    reservation_ttl_seconds: 300,
    kind: 'tool',
    cost_source_slug: 'tavily-search',
    tool_name: 'tavily_search',
    metric: 'credit',
    maximum_value: '1',
  });
}

function fixedToolPricing(requestedUsd: string): ResolveReservationPricing {
  return async ({ tx }) => {
    const snapshot: JsonObject = {
      schema_version: '1.0',
      kind: 'tool',
      source: 'cost_sources',
      pricing_id: crypto.randomUUID(),
      source_type: 'non_llm_manual',
      tracking_status: 'tracked',
      source_status: 'healthy',
      cost_source_slug: 'tavily-search',
      metric: 'credit',
      unit: 'credit',
      approved_at: '2026-07-14T00:00:00.000Z',
      pricing_model: 'flat',
      unit_cost_usd: requestedUsd,
    };
    return {
      available: true,
      requested_usd: requestedUsd,
      pricing_snapshot: snapshot,
      pricing_snapshot_hash: await jsonHash(tx, snapshot),
    };
  };
}

async function reserve(
  fixture: BuilderRuleFixture,
  request: ParsedReserveUsageRequest,
  requestedUsd: string,
) {
  return createReserveBudgetUsage({
    client: db(),
    controlEnabled: () => true,
    resolvePricing: fixedToolPricing(requestedUsd),
    maxAttempts: 1,
    sleep: async () => undefined,
  })(fixture.builderId, request, { sdkVersion: '1.2.0', sdkLanguage: 'typescript' });
}

async function readActivity(builderId: string, params = new URLSearchParams()) {
  return dashboardDb().transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SELECT set_config('app.builder_id', ${builderId}, true)`);
    return listBudgetActivityInTransaction(
      transaction,
      builderId,
      parseBudgetActivityQuery(params),
    );
  });
}

async function readActivityAcrossTenantContext(
  contextBuilderId: string,
  requestedBuilderId: string,
) {
  return dashboardDb().transaction(async (transaction) => {
    await transaction.execute(
      drizzleSql`SELECT set_config('app.builder_id', ${contextBuilderId}, true)`,
    );
    return listBudgetActivityInTransaction(
      transaction,
      requestedBuilderId,
      parseBudgetActivityQuery(new URLSearchParams()),
    );
  });
}

async function readCustomerState(builderId: string, customerId: string) {
  return dashboardDb().transaction(async (transaction) => {
    await transaction.execute(drizzleSql`SELECT set_config('app.builder_id', ${builderId}, true)`);
    return getBudgetAccountStateInTransaction(transaction, builderId, {
      customer_id: customerId,
    });
  });
}

async function authorityCounts(builderId: string) {
  return db().begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const rows = await transaction<Array<{ invoices: number; outbox: number; usage: number }>>`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM public.budget_usage_ledger
          WHERE builder_id = ${builderId}::UUID) AS usage,
        (SELECT COUNT(*)::INTEGER FROM public.budget_cost_event_outbox
          WHERE builder_id = ${builderId}::UUID) AS outbox,
        (SELECT COUNT(*)::INTEGER FROM public.invoices
          WHERE builder_id = ${builderId}::UUID) AS invoices
    `;
    return rows[0]!;
  }) as Promise<{ invoices: number; outbox: number; usage: number }>;
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'authoritative_budget_activity' });
  try {
    await applyMigrationsThrough(scratch, '051');
    pool = postgres(scratch.url, { max: 8, onnotice: () => undefined });
    dashboardPool = postgres(scratch.url, { max: 4, onnotice: () => undefined });
  } catch (error) {
    await dashboardPool?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
});

afterAll(async () => {
  try {
    await dashboardPool?.end();
    await pool?.end();
  } finally {
    await scratch?.drop();
  }
});

describe('authoritative PostgreSQL Budget Activity dashboard read model', () => {
  it('shows a refusal with full proof while keeping usage, outbox, spend, and invoices empty', async () => {
    const fixture = await createReadyBuilderWithRule('activity-refused', '1');
    const request = toolRequest('blocked_user');
    const response = await reserve(fixture, request, '2');
    expect(response).toMatchObject({ decision: 'denied', allowed: false });

    const page = await readActivity(
      fixture.builderId,
      new URLSearchParams({ status: 'refused', customer: 'blocked_user' }),
    );
    expect(page.pagination.total).toBe(1);
    expect(page.activities[0]).toMatchObject({
      status: 'refused',
      provider_request: 'not_sent',
      requested_usd: '2',
      reserved_usd: '0',
      actual_usd: '0',
      trace_id: request.trace_id,
      span_id: request.span_id,
      cost_event_id: null,
      allocations: [
        {
          rule_key: fixture.ruleKey,
          rule_name: 'activity-refused hard stop',
          committed_before_usd: '0',
          reserved_before_usd: '0',
          unresolved_before_usd: '0',
          requested_usd: '2',
          limit_usd: '1',
          remaining_usd: '1',
          status: 'refused',
          is_deciding: true,
        },
      ],
    });
    expect(await authorityCounts(fixture.builderId)).toEqual({
      usage: 0,
      outbox: 0,
      invoices: 0,
    });
    await expect(readCustomerState(fixture.builderId, 'blocked_user')).resolves.toMatchObject([
      { rule_key: fixture.ruleKey, committed_usd: '0', reserved_usd: '0', available_usd: '1' },
    ]);
  });

  it('decorates one charged reservation with its one cost-event identity', async () => {
    const fixture = await createReadyBuilderWithRule('activity-charged', '1');
    const request = toolRequest('charged_user');
    const held = await reserve(fixture, request, '0.000004');
    expect(held).toMatchObject({ decision: 'reserved', state: 'reserved' });
    if (held.decision !== 'reserved') {
      throw new Error('held fixture did not return a reserved decision');
    }

    const reservedPage = await readActivity(
      fixture.builderId,
      new URLSearchParams({ status: 'reserved', customer: 'charged_user' }),
    );
    expect(reservedPage.activities).toMatchObject([
      {
        status: 'reserved',
        provider_request: 'not_confirmed',
        reserved_usd: '0.000004',
        actual_usd: '0',
        cost_event_id: null,
      },
    ]);
    expect(await authorityCounts(fixture.builderId)).toEqual({
      usage: 0,
      outbox: 0,
      invoices: 0,
    });

    const lifecycle = createBudgetLifecycleService({
      transactionOptions: { client: db(), maxAttempts: 1 },
    });
    await lifecycle.commitBudgetUsage(
      fixture.builderId,
      held.reservation_id,
      {
        schema_version: '1.0',
        status: 'success',
        latency_ms: 42,
        stream_aborted: false,
        kind: 'tool',
        actual_value: '1',
      },
      { sdkVersion: '1.2.0', sdkLanguage: 'typescript' },
    );

    const page = await readActivity(
      fixture.builderId,
      new URLSearchParams({ status: 'charged', source: 'tavily', page_size: '10' }),
    );
    expect(page.activities).toHaveLength(1);
    expect(page.activities[0]).toMatchObject({
      status: 'charged',
      provider_request: 'sent',
      requested_usd: '0.000004',
      actual_usd: '0.000004',
      trace_id: request.trace_id,
      span_id: request.span_id,
    });
    expect(page.activities[0]?.cost_event_id).toMatch(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    );
    expect(await authorityCounts(fixture.builderId)).toEqual({
      usage: 1,
      outbox: 1,
      invoices: 0,
    });
  });

  it('shows provider-not-called releases without creating a cost event and enforces RLS', async () => {
    const fixture = await createReadyBuilderWithRule('activity-released', '1');
    const request = toolRequest('released_user');
    const held = await reserve(fixture, request, '0.1');
    if (held.decision !== 'reserved') {
      throw new Error('release fixture did not return a reserved decision');
    }
    const lifecycle = createBudgetLifecycleService({
      transactionOptions: { client: db(), maxAttempts: 1 },
    });
    await lifecycle.releaseBudgetUsage(
      fixture.builderId,
      held.reservation_id,
      { schema_version: '1.0', reason: 'provider_not_called' },
      { sdkVersion: '1.2.0', sdkLanguage: 'typescript' },
    );

    const page = await readActivity(
      fixture.builderId,
      new URLSearchParams({ status: 'released', rule_key: fixture.ruleKey }),
    );
    expect(page.activities).toMatchObject([
      {
        status: 'released',
        provider_request: 'not_sent',
        reason: 'provider_not_called',
        cost_event_id: null,
      },
    ]);
    expect(await authorityCounts(fixture.builderId)).toEqual({
      usage: 0,
      outbox: 0,
      invoices: 0,
    });

    const other = await createReadyBuilderWithRule('activity-other-tenant', '1');
    const crossTenant = await readActivityAcrossTenantContext(other.builderId, fixture.builderId);
    expect(crossTenant.activities).toEqual([]);
    expect(crossTenant.pagination.total).toBe(0);
  });
});
