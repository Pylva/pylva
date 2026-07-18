import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetBypassReason,
  BudgetUnavailableReason,
  ErrorCode,
  ReserveUsageRequestSchema,
  type ParsedReserveUsageRequest,
  type ReserveUsageResponse,
} from '@pylva/shared';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createReserveBudgetUsage,
  type EnsureBudgetAccountsMaterialized,
  type ResolveReservationPricing,
} from '../../src/lib/budget-control/reservation-service.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATION_FILENAME = '051_authoritative_budget_control_runtime.sql';
const MAX_NUMERIC_38_18 = '99999999999999999999.999999999999999999';

type LedgerSql = Sql | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;

interface RuleFixture {
  enforcement: 'hard_stop' | 'advisory';
  limitUsd: string;
  ruleKey: string;
  ruleRevisionId: string;
  scope: 'pooled' | 'per_customer';
  targetCustomerId: string | null;
}

let scratch: ScratchDb | undefined;
let pool: Sql | undefined;

function db(): Sql {
  if (!pool) throw new Error('reservation service scratch pool is not ready');
  return pool;
}

async function useBuilder(sql: LedgerSql, builderId: string): Promise<void> {
  await sql`SELECT pg_catalog.set_config('app.builder_id', ${builderId}, true)`;
}

async function jsonHash(sql: LedgerSql, input: JsonObject): Promise<string> {
  const rows = await sql<{ value: string }[]>`
    SELECT public.pylva_budget_jsonb_sha256(${sql.json(input)}::JSONB) AS value
  `;
  const hash = rows[0]?.value;
  if (!hash) throw new Error('canonical JSON hash was unavailable');
  return hash;
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'reservation_service' });
  try {
    await applyMigrationsThrough(scratch, MIGRATION_FILENAME);
    pool = postgres(scratch.url, { max: 12, onnotice: () => undefined });
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
  if (!builderId) throw new Error('builder insert returned no identity');
  return builderId;
}

async function createReadyBuilder(label: string): Promise<string> {
  const builderId = await createBuilder(label);

  await db().begin(async (tx) => {
    await useBuilder(tx, builderId);
    const cutovers = await tx<{ cutover_at: Date }[]>`
      INSERT INTO public.budget_control_cutovers (builder_id, status, mode)
      VALUES (${builderId}::UUID, 'pending', 'exact_backfill')
      RETURNING cutover_at
    `;
    const cutoverAt = cutovers[0]?.cutover_at;
    if (!cutoverAt) throw new Error('cutover insert returned no watermark');
    const cutoverText = cutoverAt.toISOString();
    const snapshot: JsonObject = {
      schema_version: '1.0',
      builder_id: builderId,
      mode: 'exact_backfill',
      cutover_at: cutoverText,
      reconciled_through: cutoverText,
    };
    const snapshotHash = await jsonHash(tx, snapshot);
    await tx`
      UPDATE public.budget_control_cutovers
      SET status = 'ready', reconciled_through = ${cutoverAt},
          reconciliation_snapshot = ${tx.json(snapshot)}::JSONB,
          reconciliation_snapshot_hash = ${snapshotHash}
      WHERE builder_id = ${builderId}::UUID
    `;
  });
  return builderId;
}

async function insertRule(
  builderId: string,
  values: Partial<{
    enforcement: 'hard_stop' | 'advisory';
    limitUsd: string;
    scope: 'pooled' | 'per_customer';
    targetCustomerId: string | null;
  }> = {},
): Promise<RuleFixture> {
  return db().begin(async (tx) => {
    await useBuilder(tx, builderId);
    const ruleKey = crypto.randomUUID();
    const ruleRevisionId = crypto.randomUUID();
    const scope = values.scope ?? 'pooled';
    const targetCustomerId = scope === 'pooled' ? null : (values.targetCustomerId ?? null);
    const enforcement = values.enforcement ?? 'hard_stop';
    const limitUsd = values.limitUsd ?? '10';
    const snapshot: JsonObject = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope,
      target_customer_id: targetCustomerId,
      period: 'day',
      enforcement,
      limit_usd: limitUsd,
    };
    const snapshotHash = await jsonHash(tx, snapshot);
    await tx`
      INSERT INTO public.budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${ruleRevisionId}::UUID, ${ruleKey}::UUID, 0,
        ${scope}, ${targetCustomerId}, 'day', ${enforcement}, ${limitUsd}::NUMERIC,
        ${tx.json(snapshot)}::JSONB, ${snapshotHash}
      )
    `;
    return {
      enforcement,
      limitUsd,
      ruleKey,
      ruleRevisionId,
      scope,
      targetCustomerId,
    };
  });
}

function accountMaterializer(
  openings: ReadonlyMap<string, string>,
): EnsureBudgetAccountsMaterialized {
  return async ({ builderId, customerId }) => {
    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await tx`
        SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(${builderId}::UUID::TEXT, 50620260714)
        )
      `;
      const cutovers = await tx<{ cutover_at: Date }[]>`
        SELECT cutover_at
        FROM public.budget_control_cutovers
        WHERE builder_id = ${builderId}::UUID AND status = 'ready'
      `;
      const cutoverAt = cutovers[0]?.cutover_at;
      if (!cutoverAt) throw new Error('builder is not ready for authoritative budget control');

      const revisions = await tx<
        {
          enforcement: 'hard_stop' | 'advisory';
          id: string;
          limit_usd: string;
          period_end: Date;
          period_start: Date;
          rule_key: string;
          scope: 'pooled' | 'per_customer';
        }[]
      >`
        WITH authoritative_time AS MATERIALIZED (
          SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS value
        )
        SELECT revision.id, revision.rule_key, revision.scope,
               revision.enforcement,
               public.pylva_budget_decimal_text(revision.limit_usd) AS limit_usd,
               date_trunc('day', authoritative_time.value AT TIME ZONE 'UTC')
                 AT TIME ZONE 'UTC' AS period_start,
               (date_trunc('day', authoritative_time.value AT TIME ZONE 'UTC')
                 + INTERVAL '1 day') AT TIME ZONE 'UTC' AS period_end
        FROM public.budget_rule_revisions revision
        CROSS JOIN authoritative_time
        WHERE revision.builder_id = ${builderId}::UUID
          AND revision.retired_at IS NULL
          AND (
            revision.target_customer_id IS NULL
            OR revision.target_customer_id = ${customerId}
          )
        ORDER BY revision.id
      `;

      for (const revision of revisions) {
        const subjectCustomerId = revision.scope === 'pooled' ? null : customerId;
        const existing = await tx<{ id: string }[]>`
          SELECT id
          FROM public.budget_accounts
          WHERE builder_id = ${builderId}::UUID
            AND rule_key = ${revision.rule_key}::UUID
            AND scope = ${revision.scope}
            AND subject_customer_id IS NOT DISTINCT FROM ${subjectCustomerId}
            AND period = 'day'
            AND period_start = ${revision.period_start}
        `;
        if (existing[0]) continue;

        const accountId = crypto.randomUUID();
        const openingUsd = openings.get(revision.rule_key) ?? '0';
        const periodStart = revision.period_start.toISOString();
        const periodEnd = revision.period_end.toISOString();
        const accountSnapshot: JsonObject = {
          schema_version: '1.0',
          rule_key: revision.rule_key,
          scope: revision.scope,
          subject_customer_id: subjectCustomerId,
          period: 'day',
          period_start: periodStart,
          period_end: periodEnd,
          enforcement: revision.enforcement,
          limit_usd: revision.limit_usd,
          opening_committed_usd: openingUsd,
        };
        const accountSnapshotHash = await jsonHash(tx, accountSnapshot);
        await tx`
          INSERT INTO public.budget_accounts (
            builder_id, id, rule_key, enforcement, limit_usd, scope,
            subject_customer_id, period, period_start, period_end,
            initial_rule_revision_id, initial_rule_snapshot,
            initial_rule_snapshot_hash, opening_committed_usd,
            committed_usd, reserved_usd, unresolved_usd
          )
          VALUES (
            ${builderId}::UUID, ${accountId}::UUID, ${revision.rule_key}::UUID,
            ${revision.enforcement}, ${revision.limit_usd}::NUMERIC, ${revision.scope},
            ${subjectCustomerId}, 'day', ${revision.period_start}, ${revision.period_end},
            ${revision.id}::UUID, ${tx.json(accountSnapshot)}::JSONB,
            ${accountSnapshotHash}, ${openingUsd}::NUMERIC, ${openingUsd}::NUMERIC,
            0, 0
          )
        `;

        const cutoverText = cutoverAt.toISOString();
        const evidenceSnapshot: JsonObject = {
          schema_version: '1.0',
          source: 'exact_backfill',
          builder_id: builderId,
          account_id: accountId,
          rule_key: revision.rule_key,
          scope: revision.scope,
          subject_customer_id: subjectCustomerId,
          period: 'day',
          period_start: periodStart,
          period_end: periodEnd,
          cutover_at: cutoverText,
          measured_through: cutoverText,
          opening_committed_usd: openingUsd,
        };
        const evidenceHash = await jsonHash(tx, evidenceSnapshot);
        await tx`
          INSERT INTO public.budget_account_opening_evidence (
            builder_id, account_id, source, opening_committed_usd,
            measured_through, evidence_snapshot, evidence_snapshot_hash
          )
          VALUES (
            ${builderId}::UUID, ${accountId}::UUID, 'exact_backfill',
            ${openingUsd}::NUMERIC, ${cutoverAt},
            ${tx.json(evidenceSnapshot)}::JSONB, ${evidenceHash}
          )
        `;
      }
    });
  };
}

function fixedPricing(requestedUsd: string): ResolveReservationPricing {
  return async ({ tx, usage }) => {
    const snapshot: JsonObject =
      usage.kind === 'llm'
        ? {
            schema_version: '1.0',
            provider: usage.provider,
            model: usage.model,
            input_per_million_usd: '0.15',
            output_per_million_usd: '0.6',
          }
        : {
            schema_version: '1.0',
            cost_source_slug: usage.cost_source_slug,
            metric: usage.metric,
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

function unavailablePricing(
  cause: 'invalid_input' | 'not_found' | 'ambiguous' | 'malformed' | 'out_of_range',
): ResolveReservationPricing {
  return async () => ({ available: false, reason: 'pricing_unavailable', cause });
}

function unsafePricingResult(
  resolve: (tx: TransactionSql) => unknown | Promise<unknown>,
): ResolveReservationPricing {
  return (async ({ tx }) => resolve(tx)) as ResolveReservationPricing;
}

function service(
  openings: ReadonlyMap<string, string>,
  pricing: ResolveReservationPricing,
  ensure: EnsureBudgetAccountsMaterialized = accountMaterializer(openings),
) {
  return createReserveBudgetUsage({
    client: db(),
    controlEnabled: () => true,
    ensureBudgetAccountsMaterialized: ensure,
    resolvePricing: pricing,
    sleep: async () => undefined,
  });
}

function llmRequest(overrides: Partial<ParsedReserveUsageRequest> = {}): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: crypto.randomUUID(),
    customer_id: 'customer_1',
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'agent.call',
    kind: 'llm',
    provider: 'openai',
    model: 'gpt-4o-mini',
    estimated_input_tokens: 100,
    max_output_tokens: 50,
    ...overrides,
  });
}

function toolRequest(
  overrides: Partial<ParsedReserveUsageRequest> = {},
): ParsedReserveUsageRequest {
  return v.parse(ReserveUsageRequestSchema, {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: crypto.randomUUID(),
    customer_id: 'customer_1',
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'tool.call',
    kind: 'tool',
    cost_source_slug: 'tavily-search',
    tool_name: 'tavily_search',
    metric: 'credit',
    maximum_value: '1',
    ...overrides,
  });
}

async function tenantRead<T>(
  builderId: string,
  read: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await db().begin(async (tx) => {
    await useBuilder(tx, builderId);
    return read(tx);
  });
  return result as T;
}

describe('authoritative PostgreSQL reservation service', () => {
  it.each([
    ['missing', 'enforce'],
    ['missing', 'shadow'],
    ['pending', 'enforce'],
    ['pending', 'shadow'],
  ] as const)(
    'fails %s readiness closed in %s mode before rules or pricing are evaluated',
    async (readiness, mode) => {
      const builderId = await createBuilder(`reserve-readiness-${readiness}-${mode}`);
      if (readiness === 'pending') {
        await db().begin(async (tx) => {
          await useBuilder(tx, builderId);
          await tx`
            INSERT INTO public.budget_control_cutovers (builder_id, status, mode)
            VALUES (${builderId}::UUID, 'pending', 'exact_backfill')
          `;
        });
      }
      let pricingCalls = 0;
      const pricing: ResolveReservationPricing = async () => {
        pricingCalls += 1;
        throw new Error('pricing must not run before readiness is proved');
      };
      // A deliberately permissive adapter proves authorization has its own
      // fresh readiness boundary and cannot rely only on materialization.
      const reserve = service(new Map(), pricing, async () => undefined);

      const response = await reserve(builderId, llmRequest({ mode }));

      expect(pricingCalls).toBe(0);
      expect(response.decision_id).not.toBeNull();
      if (mode === 'enforce') {
        expect(response).toMatchObject({
          decision: 'unavailable',
          allowed: false,
          reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
          retryable: false,
        });
      } else {
        expect(response).toEqual(
          expect.objectContaining({
            decision: 'bypassed',
            allowed: true,
            reason: BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
            would_have_denied: null,
            warnings: [],
          }),
        );
      }
      await tenantRead(builderId, async (tx) => {
        const rows = await tx<
          {
            allocation_count: string;
            pricing_snapshot: unknown;
            requested_usd: string | null;
          }[]
        >`
          SELECT reservation.requested_usd::TEXT,
                 reservation.pricing_snapshot,
                 (SELECT COUNT(*)::TEXT
                  FROM public.budget_reservation_allocations allocation
                  WHERE allocation.builder_id = reservation.builder_id
                    AND allocation.reservation_decision_id = reservation.decision_id)
                   AS allocation_count
          FROM public.budget_reservations reservation
          WHERE reservation.builder_id = ${builderId}::UUID
        `;
        expect(rows[0]).toEqual({
          requested_usd: null,
          pricing_snapshot: null,
          allocation_count: '0',
        });
      });
    },
  );

  it('allows exact equality and posts one complete hold', async () => {
    const builderId = await createReadyBuilder('reserve-equality');
    const rule = await insertRule(builderId, { limitUsd: '1' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'));

    const response = await reserve(builderId, llmRequest());

    expect(response).toMatchObject({
      decision: 'reserved',
      allowed: true,
      reserved_usd: '1',
      remaining_usd: '0',
      state: 'reserved',
    });
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ reserved_usd: string; version: string }[]>`
        SELECT public.pylva_budget_decimal_text(reserved_usd) AS reserved_usd,
               version::TEXT AS version
        FROM public.budget_accounts
        WHERE builder_id = ${builderId}::UUID AND rule_key = ${rule.ruleKey}::UUID
      `;
      expect(rows[0]).toEqual({ reserved_usd: '1', version: '1' });
    });
  });

  it('refuses an over-limit request without posting a partial hold', async () => {
    const builderId = await createReadyBuilder('reserve-denied');
    const rule = await insertRule(builderId, { limitUsd: '1' });
    const reserve = service(new Map([[rule.ruleKey, '1']]), fixedPricing('0.01'));

    const response = await reserve(builderId, llmRequest());

    expect(response).toMatchObject({
      decision: 'denied',
      allowed: false,
      committed_usd: '1',
      reserved_usd: '0',
      requested_usd: '0.01',
      limit_usd: '1',
      remaining_usd: '0',
    });
    await tenantRead(builderId, async (tx) => {
      const accounts = await tx<{ reserved_usd: string }[]>`
        SELECT reserved_usd::TEXT AS reserved_usd
        FROM public.budget_accounts WHERE builder_id = ${builderId}::UUID
      `;
      const allocations = await tx<{ status: string }[]>`
        SELECT status FROM public.budget_reservation_allocations
        WHERE builder_id = ${builderId}::UUID
      `;
      expect(accounts).toEqual([{ reserved_usd: '0.000000000000000000' }]);
      expect(allocations).toEqual([{ status: 'refused' }]);
    });
  });

  it('emits an advisory warning but still holds the request', async () => {
    const builderId = await createReadyBuilder('reserve-advisory');
    const rule = await insertRule(builderId, {
      enforcement: 'advisory',
      limitUsd: '0',
    });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'));

    const response = await reserve(builderId, llmRequest());

    expect(response).toMatchObject({
      decision: 'reserved',
      remaining_usd: null,
      warnings: [
        {
          code: 'advisory_budget_exceeded',
          rule_id: rule.ruleKey,
          limit_usd: '0',
          projected_usd: '1',
        },
      ],
    });
  });

  it('records shadow would-deny with no hold or provider-side effect', async () => {
    const builderId = await createReadyBuilder('reserve-shadow');
    const rule = await insertRule(builderId, { limitUsd: '0' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'));

    const response = await reserve(builderId, llmRequest({ mode: 'shadow' }));

    expect(response).toMatchObject({
      decision: 'bypassed',
      allowed: true,
      reason: BudgetBypassReason.SHADOW_WOULD_DENY,
      would_have_denied: true,
    });
    await tenantRead(builderId, async (tx) => {
      const accounts = await tx<{ reserved_usd: string }[]>`
        SELECT reserved_usd::TEXT AS reserved_usd
        FROM public.budget_accounts WHERE builder_id = ${builderId}::UUID
      `;
      const allocations = await tx<{ status: string }[]>`
        SELECT status FROM public.budget_reservation_allocations
        WHERE builder_id = ${builderId}::UUID
      `;
      expect(accounts[0]?.reserved_usd).toBe('0.000000000000000000');
      expect(allocations).toEqual([{ status: 'shadow' }]);
    });
  });

  it('serializes a concurrent duplicate race and replays one exact stored decision', async () => {
    const builderId = await createReadyBuilder('reserve-replay-race');
    const rule = await insertRule(builderId, { limitUsd: '10' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'));
    const request = llmRequest();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => reserve(builderId, request)),
    );

    expect(new Set(responses.map((response) => JSON.stringify(response))).size).toBe(1);
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ allocations: string; reservations: string; reserved: string }[]>`
        SELECT
          (SELECT COUNT(*)::TEXT FROM public.budget_reservations
             WHERE builder_id = ${builderId}::UUID) AS reservations,
          (SELECT COUNT(*)::TEXT FROM public.budget_reservation_allocations
             WHERE builder_id = ${builderId}::UUID) AS allocations,
          (SELECT public.pylva_budget_decimal_text(reserved_usd)
             FROM public.budget_accounts
             WHERE builder_id = ${builderId}::UUID) AS reserved
      `;
      expect(rows[0]).toEqual({ reservations: '1', allocations: '1', reserved: '1' });
    });
  });

  it('serializes distinct operations contending at the exact limit without overspending', async () => {
    const builderId = await createReadyBuilder('reserve-distinct-exact-limit');
    const rule = await insertRule(builderId, { limitUsd: '1' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'));

    const responses = await Promise.all([
      reserve(builderId, llmRequest()),
      reserve(builderId, llmRequest()),
    ]);

    expect(responses.map((response) => response.decision).sort()).toEqual(['denied', 'reserved']);
    const reserved = responses.find((response) => response.decision === 'reserved');
    const denied = responses.find((response) => response.decision === 'denied');
    expect(reserved).toMatchObject({ reserved_usd: '1', remaining_usd: '0' });
    expect(denied).toMatchObject({
      requested_usd: '1',
      reserved_usd: '1',
      remaining_usd: '0',
    });

    await tenantRead(builderId, async (tx) => {
      const rows = await tx<
        {
          allocation_count: string;
          decisions: string[];
          reserved_usd: string;
          version: string;
        }[]
      >`
        SELECT
          (SELECT ARRAY_AGG(decision ORDER BY decision)
           FROM public.budget_reservations
           WHERE builder_id = ${builderId}::UUID) AS decisions,
          (SELECT COUNT(*)::TEXT
           FROM public.budget_reservation_allocations
           WHERE builder_id = ${builderId}::UUID) AS allocation_count,
          public.pylva_budget_decimal_text(account.reserved_usd) AS reserved_usd,
          account.version::TEXT AS version
        FROM public.budget_accounts account
        WHERE account.builder_id = ${builderId}::UUID
      `;
      expect(rows[0]).toEqual({
        decisions: ['denied', 'reserved'],
        allocation_count: '2',
        reserved_usd: '1',
        version: '1',
      });
    });
  });

  it('allows exactly ten of 100 simultaneous $0.10 operations against one $1 hard-stop account', async () => {
    const roundDurationsMs: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      const builderId = await createReadyBuilder(`reserve-100-way-${round}`);
      const rule = await insertRule(builderId, { limitUsd: '1' });
      const openings = new Map([[rule.ruleKey, '0']]);

      // Keep account creation outside the contention window so this gate
      // measures the serialized authorization boundary itself. Every one of
      // the 100 logical operations still uses the production PostgreSQL
      // authorization transaction and a distinct operation identity.
      await accountMaterializer(openings)({ builderId, customerId: 'customer_1' });
      const reserve = service(openings, fixedPricing('0.1'), async () => undefined);
      const requests = Array.from({ length: 100 }, () => llmRequest());
      const startedAt = performance.now();
      const responses = await Promise.all(requests.map((request) => reserve(builderId, request)));
      roundDurationsMs.push(performance.now() - startedAt);

      const decisions = responses.reduce(
        (counts, response) => {
          counts[response.decision] = (counts[response.decision] ?? 0) + 1;
          return counts;
        },
        {} as Record<string, number>,
      );
      expect(decisions).toEqual({ denied: 90, reserved: 10 });
      expect(
        responses
          .filter((response) => response.decision === 'reserved')
          .every(
            (response) =>
              response.reserved_usd === '0.1' && response.allowed && response.state === 'reserved',
          ),
      ).toBe(true);

      await tenantRead(builderId, async (tx) => {
        const rows = await tx<
          {
            account_total_usd: string;
            account_version: string;
            allocation_count: string;
            allocation_total_usd: string;
            denied_count: string;
            distinct_operations: string;
            held_count: string;
            reservation_count: string;
            reservation_total_usd: string;
            reserved_count: string;
          }[]
        >`
            SELECT
              (SELECT COUNT(*)::TEXT
               FROM public.budget_reservations reservation
               WHERE reservation.builder_id = ${builderId}::UUID) AS reservation_count,
              (SELECT COUNT(DISTINCT operation_id)::TEXT
               FROM public.budget_reservations reservation
               WHERE reservation.builder_id = ${builderId}::UUID) AS distinct_operations,
              (SELECT COUNT(*) FILTER (WHERE decision = 'reserved')::TEXT
               FROM public.budget_reservations reservation
               WHERE reservation.builder_id = ${builderId}::UUID) AS reserved_count,
              (SELECT COUNT(*) FILTER (WHERE decision = 'denied')::TEXT
               FROM public.budget_reservations reservation
               WHERE reservation.builder_id = ${builderId}::UUID) AS denied_count,
              (SELECT public.pylva_budget_decimal_text(SUM(reserved_usd))
               FROM public.budget_reservations reservation
               WHERE reservation.builder_id = ${builderId}::UUID) AS reservation_total_usd,
              (SELECT COUNT(*)::TEXT
               FROM public.budget_reservation_allocations allocation
               WHERE allocation.builder_id = ${builderId}::UUID) AS allocation_count,
              (SELECT COUNT(*) FILTER (WHERE held_at_reserve)::TEXT
               FROM public.budget_reservation_allocations allocation
               WHERE allocation.builder_id = ${builderId}::UUID) AS held_count,
              (SELECT public.pylva_budget_decimal_text(SUM(authorized_usd))
               FROM public.budget_reservation_allocations allocation
               WHERE allocation.builder_id = ${builderId}::UUID) AS allocation_total_usd,
              public.pylva_budget_decimal_text(
                account.committed_usd + account.reserved_usd + account.unresolved_usd
              ) AS account_total_usd,
              account.version::TEXT AS account_version
            FROM public.budget_accounts account
            WHERE account.builder_id = ${builderId}::UUID
              AND account.rule_key = ${rule.ruleKey}::UUID
          `;
        expect(rows[0]).toEqual({
          account_total_usd: '1',
          account_version: '10',
          allocation_count: '100',
          allocation_total_usd: '1',
          denied_count: '90',
          distinct_operations: '100',
          held_count: '10',
          reservation_count: '100',
          reservation_total_usd: '1',
          reserved_count: '10',
        });
      });
    }

    console.info(
      '[budget-load-gate] 100-way reservation contention',
      JSON.stringify({
        rounds: roundDurationsMs.length,
        durations_ms: roundDurationsMs.map((value) => Math.round(value)),
        max_ms: Math.round(Math.max(...roundDurationsMs)),
      }),
    );
  }, 120_000);

  it('replays a committed reservation after a simulated lost response without repricing or reposting', async () => {
    const builderId = await createReadyBuilder('reserve-lost-commit-ack');
    const rule = await insertRule(builderId, { limitUsd: '10' });
    let pricingCalls = 0;
    const pricing = fixedPricing('1');
    const committedService = service(new Map([[rule.ruleKey, '0']]), async (input) => {
      pricingCalls += 1;
      return pricing(input);
    });
    const request = llmRequest();
    let droppedResponses = 0;
    const reserve = createReserveBudgetUsage({
      client: db(),
      controlEnabled: () => true,
      ensureBudgetAccountsMaterialized: async () => undefined,
      authorizeAttempt: async (input) => {
        const committed = await committedService(input.builderId, input.request, input.sdkIdentity);
        droppedResponses += 1;
        throw Object.assign(new Error('simulated response loss after commit'), { committed });
      },
      sleep: async () => undefined,
    });

    const response = await reserve(builderId, request);

    expect(response).toMatchObject({ decision: 'reserved', reserved_usd: '1' });
    expect(droppedResponses).toBe(1);
    expect(pricingCalls).toBe(1);
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<
        { allocations: string; reservations: string; reserved: string; version: string }[]
      >`
        SELECT
          (SELECT COUNT(*)::TEXT FROM public.budget_reservations
           WHERE builder_id = ${builderId}::UUID) AS reservations,
          (SELECT COUNT(*)::TEXT FROM public.budget_reservation_allocations
           WHERE builder_id = ${builderId}::UUID) AS allocations,
          public.pylva_budget_decimal_text(account.reserved_usd) AS reserved,
          account.version::TEXT AS version
        FROM public.budget_accounts account
        WHERE account.builder_id = ${builderId}::UUID
      `;
      expect(rows[0]).toEqual({
        reservations: '1',
        allocations: '1',
        reserved: '1',
        version: '1',
      });
    });
  });

  it('returns 409 semantics for an operation ID reused with a different canonical body', async () => {
    const builderId = await createReadyBuilder('reserve-conflict');
    const rule = await insertRule(builderId, { limitUsd: '10' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'));
    const operationId = crypto.randomUUID();

    await reserve(builderId, llmRequest({ operation_id: operationId, max_output_tokens: 50 }));

    await expect(
      reserve(builderId, llmRequest({ operation_id: operationId, max_output_tokens: 51 })),
    ).rejects.toMatchObject({ code: ErrorCode.IDEMPOTENCY_CONFLICT, status: 409 });
  });

  it('evaluates every applicable pooled and global per-customer rule in account-ID order', async () => {
    const builderId = await createReadyBuilder('reserve-multi-account');
    const pooled = await insertRule(builderId, { limitUsd: '10' });
    const perCustomer = await insertRule(builderId, {
      limitUsd: '0',
      scope: 'per_customer',
    });
    const reserve = service(
      new Map([
        [pooled.ruleKey, '0'],
        [perCustomer.ruleKey, '0'],
      ]),
      fixedPricing('1'),
    );

    const response = await reserve(builderId, llmRequest());

    expect(response.decision).toBe('denied');
    await tenantRead(builderId, async (tx) => {
      const allocations = await tx<
        { account_id: string; evaluation_order: number; status: string }[]
      >`
        SELECT account_id::TEXT, evaluation_order, status
        FROM public.budget_reservation_allocations
        WHERE builder_id = ${builderId}::UUID
        ORDER BY evaluation_order
      `;
      expect(allocations).toHaveLength(2);
      expect(allocations.map((row) => row.account_id)).toEqual(
        [...allocations.map((row) => row.account_id)].sort(),
      );
      expect(allocations.map((row) => row.status).sort()).toEqual(['not_held', 'refused']);
      const accounts = await tx<{ reserved_usd: string }[]>`
        SELECT reserved_usd::TEXT AS reserved_usd
        FROM public.budget_accounts WHERE builder_id = ${builderId}::UUID
      `;
      expect(accounts.every((row) => row.reserved_usd === '0.000000000000000000')).toBe(true);
    });
  });

  it('rolls back the entire multi-account hold when a later allocation insert fails', async () => {
    const builderId = await createReadyBuilder('reserve-atomic-allocation-failure');
    const pooled = await insertRule(builderId, { limitUsd: '10' });
    const perCustomer = await insertRule(builderId, {
      limitUsd: '10',
      scope: 'per_customer',
    });
    const reserve = service(
      new Map([
        [pooled.ruleKey, '0'],
        [perCustomer.ruleKey, '0'],
      ]),
      fixedPricing('1'),
    );

    await db()`
      CREATE FUNCTION public.pylva_test_fail_second_reservation_allocation()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      SET search_path = pg_catalog
      AS $function$
      BEGIN
        IF NEW.evaluation_order = 1 THEN
          RAISE EXCEPTION 'injected second allocation failure'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $function$
    `;
    await db()`
      CREATE TRIGGER pylva_test_fail_second_reservation_allocation
      BEFORE INSERT ON public.budget_reservation_allocations
      FOR EACH ROW
      EXECUTE FUNCTION public.pylva_test_fail_second_reservation_allocation()
    `;

    let response: ReserveUsageResponse | null = null;
    try {
      response = await reserve(builderId, llmRequest());
    } finally {
      await db()`
        DROP TRIGGER pylva_test_fail_second_reservation_allocation
        ON public.budget_reservation_allocations
      `;
      await db()`DROP FUNCTION public.pylva_test_fail_second_reservation_allocation()`;
    }

    expect(response).not.toBeNull();
    expect(response).toMatchObject({
      decision: 'unavailable',
      allowed: false,
      reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
      retryable: true,
    });
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<
        {
          allocation_count: string;
          account_versions: string[];
          decision: string;
          reservation_count: string;
          reserved_total: string;
        }[]
      >`
        SELECT
          (SELECT COUNT(*)::TEXT
           FROM public.budget_reservations
           WHERE builder_id = ${builderId}::UUID) AS reservation_count,
          (SELECT decision
           FROM public.budget_reservations
           WHERE builder_id = ${builderId}::UUID) AS decision,
          (SELECT COUNT(*)::TEXT
           FROM public.budget_reservation_allocations
           WHERE builder_id = ${builderId}::UUID) AS allocation_count,
          (SELECT public.pylva_budget_decimal_text(SUM(reserved_usd))
           FROM public.budget_accounts
           WHERE builder_id = ${builderId}::UUID) AS reserved_total,
          (SELECT ARRAY_AGG(version::TEXT ORDER BY id)
           FROM public.budget_accounts
           WHERE builder_id = ${builderId}::UUID) AS account_versions
      `;
      expect(rows[0]).toEqual({
        reservation_count: '1',
        decision: 'unavailable',
        allocation_count: '0',
        reserved_total: '0',
        account_versions: ['0', '0'],
      });
    });
  });

  it('isolates the same operation ID across two builders', async () => {
    const [builderA, builderB] = await Promise.all([
      createReadyBuilder('reserve-tenant-a'),
      createReadyBuilder('reserve-tenant-b'),
    ]);
    const [ruleA, ruleB] = await Promise.all([
      insertRule(builderA, { limitUsd: '10' }),
      insertRule(builderB, { limitUsd: '10' }),
    ]);
    const operationId = crypto.randomUUID();
    const reserveA = service(new Map([[ruleA.ruleKey, '0']]), fixedPricing('1'));
    const reserveB = service(new Map([[ruleB.ruleKey, '0']]), fixedPricing('1'));

    const [responseA, responseB] = await Promise.all([
      reserveA(builderA, llmRequest({ operation_id: operationId })),
      reserveB(builderB, llmRequest({ operation_id: operationId })),
    ]);

    expect(responseA.decision).toBe('reserved');
    expect(responseB.decision).toBe('reserved');
    expect(responseA.decision_id).not.toBe(responseB.decision_id);
    await Promise.all(
      [builderA, builderB].map((builderId) =>
        tenantRead(builderId, async (tx) => {
          const rows = await tx<{ count: string }[]>`
            SELECT COUNT(*)::TEXT AS count
            FROM public.budget_reservations
            WHERE builder_id = ${builderId}::UUID
              AND operation_id = ${operationId}::UUID
          `;
          expect(rows[0]?.count).toBe('1');
        }),
      ),
    );
  });

  it('persists a no-applicable-budget bypass without pricing or allocations', async () => {
    const builderId = await createReadyBuilder('reserve-no-budget');
    let pricingCalls = 0;
    const reserve = service(new Map(), async () => {
      pricingCalls += 1;
      return { available: false, reason: 'pricing_unavailable', cause: 'not_found' };
    });

    const response = await reserve(builderId, llmRequest());

    expect(response).toMatchObject({
      decision: 'bypassed',
      reason: BudgetBypassReason.NO_APPLICABLE_BUDGET,
      would_have_denied: null,
    });
    expect(pricingCalls).toBe(0);
  });

  it.each([
    ['invalid_input', BudgetUnavailableReason.USAGE_BOUND_REQUIRED],
    ['not_found', BudgetUnavailableReason.PRICING_UNAVAILABLE],
    ['ambiguous', BudgetUnavailableReason.PRICING_UNAVAILABLE],
    ['malformed', BudgetUnavailableReason.CONTROL_UNAVAILABLE],
    ['out_of_range', BudgetUnavailableReason.CONTROL_UNAVAILABLE],
  ] as const)(
    'persists deterministic %s pricing failure as non-retryable',
    async (cause, reason) => {
      const builderId = await createReadyBuilder(`reserve-price-${cause}`);
      const rule = await insertRule(builderId, { limitUsd: '10' });
      const reserve = service(new Map([[rule.ruleKey, '0']]), unavailablePricing(cause));

      const response = await reserve(builderId, llmRequest());

      expect(response).toMatchObject({
        decision: 'unavailable',
        allowed: false,
        reason,
        retryable: false,
      });
      expect(response.decision_id).not.toBeNull();
    },
  );

  it('replays a deterministic pricing-unavailable decision without invoking pricing again', async () => {
    const builderId = await createReadyBuilder('reserve-price-unavailable-replay');
    const rule = await insertRule(builderId, { limitUsd: '10' });
    let pricingCalls = 0;
    const reserve = service(new Map([[rule.ruleKey, '0']]), async () => {
      pricingCalls += 1;
      return { available: false, reason: 'pricing_unavailable', cause: 'not_found' };
    });
    const request = llmRequest();

    const first = await reserve(builderId, request);
    const replay = await reserve(builderId, request);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      decision: 'unavailable',
      reason: BudgetUnavailableReason.PRICING_UNAVAILABLE,
      retryable: false,
    });
    expect(pricingCalls).toBe(1);
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ allocations: string; reservations: string }[]>`
        SELECT
          (SELECT COUNT(*)::TEXT FROM public.budget_reservations
           WHERE builder_id = ${builderId}::UUID) AS reservations,
          (SELECT COUNT(*)::TEXT FROM public.budget_reservation_allocations
           WHERE builder_id = ${builderId}::UUID) AS allocations
      `;
      expect(rows[0]).toEqual({ reservations: '1', allocations: '0' });
    });
  });

  it.each([
    ['null_result', 'null'],
    ['invalid_discriminant', 'disc'],
    ['invalid_unavailable_cause', 'cause'],
    ['noncanonical_amount', 'amount'],
    ['null_snapshot', 'null-snap'],
    ['array_snapshot', 'array'],
    ['cyclic_snapshot', 'cycle'],
    ['nonfinite_snapshot', 'nonfinite'],
    ['hash_format', 'hash-format'],
    ['hash_mismatch', 'hash'],
  ] as const)(
    'persists malformed pricing adapter output (%s) as deterministic unavailable',
    async (kind, label) => {
      const builderId = await createReadyBuilder(`reserve-bad-${label}`);
      const rule = await insertRule(builderId, { limitUsd: '10' });
      let pricingCalls = 0;
      const reserve = service(
        new Map([[rule.ruleKey, '0']]),
        unsafePricingResult(async (tx) => {
          pricingCalls += 1;
          const snapshot: JsonObject = {
            schema_version: '1.0',
            provider: 'openai',
            model: 'gpt-4o-mini',
          };
          const validHash = await jsonHash(tx, snapshot);
          switch (kind) {
            case 'null_result':
              return null;
            case 'invalid_discriminant':
              return { available: 'yes' };
            case 'invalid_unavailable_cause':
              return {
                available: false,
                reason: 'pricing_unavailable',
                cause: 'corrupt',
              };
            case 'noncanonical_amount':
              return {
                available: true,
                requested_usd: '1.0',
                pricing_snapshot: snapshot,
                pricing_snapshot_hash: validHash,
              };
            case 'null_snapshot':
              return {
                available: true,
                requested_usd: '1',
                pricing_snapshot: null,
                pricing_snapshot_hash: validHash,
              };
            case 'array_snapshot':
              return {
                available: true,
                requested_usd: '1',
                pricing_snapshot: [],
                pricing_snapshot_hash: validHash,
              };
            case 'cyclic_snapshot': {
              const cyclic: Record<string, unknown> = { schema_version: '1.0' };
              cyclic.self = cyclic;
              return {
                available: true,
                requested_usd: '1',
                pricing_snapshot: cyclic,
                pricing_snapshot_hash: validHash,
              };
            }
            case 'nonfinite_snapshot':
              return {
                available: true,
                requested_usd: '1',
                pricing_snapshot: { schema_version: '1.0', rate: Number.POSITIVE_INFINITY },
                pricing_snapshot_hash: validHash,
              };
            case 'hash_format':
              return {
                available: true,
                requested_usd: '1',
                pricing_snapshot: snapshot,
                pricing_snapshot_hash: 'G'.repeat(64),
              };
            case 'hash_mismatch':
              return {
                available: true,
                requested_usd: '1',
                pricing_snapshot: snapshot,
                pricing_snapshot_hash: '0'.repeat(64),
              };
          }
        }),
      );
      const request = llmRequest();

      const first = await reserve(builderId, request);
      const replay = await reserve(builderId, request);

      expect(replay).toEqual(first);
      expect(first).toMatchObject({
        decision: 'unavailable',
        allowed: false,
        reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
        retryable: false,
      });
      expect(pricingCalls).toBe(1);
      await tenantRead(builderId, async (tx) => {
        const rows = await tx<
          {
            allocation_count: string;
            pricing_snapshot: unknown;
            requested_usd: string | null;
            reserved_usd: string;
            version: string;
          }[]
        >`
        SELECT reservation.requested_usd::TEXT,
               reservation.pricing_snapshot,
               (SELECT COUNT(*)::TEXT
                FROM public.budget_reservation_allocations allocation
                WHERE allocation.builder_id = reservation.builder_id
                  AND allocation.reservation_decision_id = reservation.decision_id)
                 AS allocation_count,
               public.pylva_budget_decimal_text(account.reserved_usd) AS reserved_usd,
               account.version::TEXT AS version
        FROM public.budget_reservations reservation
        JOIN public.budget_accounts account
          ON account.builder_id = reservation.builder_id
        WHERE reservation.builder_id = ${builderId}::UUID
      `;
        expect(rows[0]).toEqual({
          requested_usd: null,
          pricing_snapshot: null,
          allocation_count: '0',
          reserved_usd: '0',
          version: '0',
        });
      });
    },
  );

  it('persists shadow control-unavailable as allowed with no pricing or allocations', async () => {
    const builderId = await createReadyBuilder('reserve-shadow-unavailable');
    const rule = await insertRule(builderId, { limitUsd: '10' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), unavailablePricing('not_found'));

    const response = await reserve(builderId, llmRequest({ mode: 'shadow' }));

    expect(response).toMatchObject({
      decision: 'bypassed',
      allowed: true,
      reason: BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
      would_have_denied: null,
    });
    expect(response.decision_id).not.toBeNull();
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ allocation_count: string; requested_usd: string | null }[]>`
        SELECT reservation.requested_usd::TEXT,
               (SELECT COUNT(*)::TEXT
                FROM public.budget_reservation_allocations allocation
                WHERE allocation.builder_id = reservation.builder_id
                  AND allocation.reservation_decision_id = reservation.decision_id)
                 AS allocation_count
        FROM public.budget_reservations reservation
        WHERE reservation.builder_id = ${builderId}::UUID
      `;
      expect(rows[0]).toEqual({ requested_usd: null, allocation_count: '0' });
    });
  });

  it('fails closed without allocations when derived account arithmetic exceeds NUMERIC(38,18)', async () => {
    const builderId = await createReadyBuilder('reserve-range-overflow');
    const rule = await insertRule(builderId, { limitUsd: MAX_NUMERIC_38_18 });
    const reserve = service(
      new Map([[rule.ruleKey, MAX_NUMERIC_38_18]]),
      fixedPricing('0.000000000000000001'),
    );

    const response = await reserve(builderId, llmRequest());

    expect(response).toMatchObject({
      decision: 'unavailable',
      allowed: false,
      reason: BudgetUnavailableReason.CONTROL_UNAVAILABLE,
      retryable: false,
    });
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM public.budget_reservation_allocations
        WHERE builder_id = ${builderId}::UUID
      `;
      expect(rows[0]?.count).toBe('0');
    });
  });

  it('consumes account serialization identity for a zero-dollar tool hold', async () => {
    const builderId = await createReadyBuilder('reserve-zero');
    const rule = await insertRule(builderId, { limitUsd: '0' });
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('0'));

    const response = await reserve(builderId, toolRequest());

    expect(response).toMatchObject({
      decision: 'reserved',
      allowed: true,
      reserved_usd: '0',
      remaining_usd: '0',
    });
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ reserved_usd: string; version: string }[]>`
        SELECT reserved_usd::TEXT AS reserved_usd, version::TEXT AS version
        FROM public.budget_accounts WHERE builder_id = ${builderId}::UUID
      `;
      expect(rows[0]).toEqual({ reserved_usd: '0.000000000000000000', version: '1' });
    });
  });

  it('re-materializes on a fresh attempt after a real missing-account closure', async () => {
    const builderId = await createReadyBuilder('reserve-closure-retry');
    const rule = await insertRule(builderId, { limitUsd: '10' });
    const materialize = accountMaterializer(new Map([[rule.ruleKey, '0']]));
    let attempts = 0;
    const ensure: EnsureBudgetAccountsMaterialized = async (input) => {
      attempts += 1;
      if (attempts > 1) await materialize(input);
    };
    const reserve = service(new Map([[rule.ruleKey, '0']]), fixedPricing('1'), ensure);

    const response = await reserve(builderId, llmRequest());

    expect(response.decision).toBe('reserved');
    expect(attempts).toBe(2);
    await tenantRead(builderId, async (tx) => {
      const rows = await tx<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM public.budget_reservations WHERE builder_id = ${builderId}::UUID
      `;
      expect(rows[0]?.count).toBe('1');
    });
  });
});
