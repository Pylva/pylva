import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres, { type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const MIGRATION_FILENAME = '050_authoritative_budget_control_ledger.sql';
const MIGRATION_PATH = path.resolve('db/migrations', MIGRATION_FILENAME);
const LEDGER_TABLES = [
  'budget_accounts',
  'budget_rule_revisions',
  'budget_reservations',
  'budget_reservation_allocations',
  'budget_reservation_transitions',
  'budget_usage_ledger',
  'budget_cost_event_outbox',
] as const;
const LEDGER_TRIGGERS = [
  'budget_accounts_immutability_guard',
  'budget_rule_revisions_immutability_guard',
  'budget_rule_revisions_successor_consistency_guard',
  'budget_reservations_immutability_guard',
  'budget_reservations_usage_consistency_guard',
  'budget_reservations_transition_consistency_guard',
  'budget_reservations_allocations_consistency_guard',
  'budget_reservation_allocations_insert_guard',
  'budget_reservation_allocations_immutability_guard',
  'budget_reservation_allocations_posting_guard',
  'budget_reservation_allocations_parent_consistency_guard',
  'budget_reservation_transitions_append_only_guard',
  'budget_reservation_transitions_parent_consistency_guard',
  'budget_usage_ledger_immutability_guard',
  'budget_usage_ledger_parent_consistency_guard',
  'budget_usage_ledger_retention_pair_guard',
  'budget_cost_event_outbox_immutability_guard',
  'budget_cost_event_outbox_retention_pair_guard',
] as const;

const FUTURE_PERIOD_START = '2030-01-01T00:00:00.000Z';
const FUTURE_PERIOD_END = '2030-01-02T00:00:00.000Z';
const PAST_PERIOD_START = '2020-01-01T00:00:00.000Z';
const PAST_PERIOD_END = '2020-01-02T00:00:00.000Z';
const PAST_RESERVED_AT = '2020-01-01T00:00:00.000Z';
const PAST_COMMITTED_AT = '2020-01-01T00:01:00.000Z';
const PRICING_SNAPSHOT = {
  schema_version: '1.0',
  provider: 'openai',
  model: 'gpt-4o-mini',
  input_per_million_usd: '0.15',
  output_per_million_usd: '0.6',
} as const;
const TOOL_PRICING_SNAPSHOT = {
  schema_version: '1.0',
  cost_source_slug: 'tavily-search',
  metric: 'credit',
  unit_cost_usd: '0.75',
} as const;

type Db = ScratchDb['sql'];
type LedgerSql = Db | TransactionSql;
type JsonObject = Record<string, postgres.JSONValue | undefined>;
type DecisionKind =
  | 'reserved'
  | 'denied'
  | 'shadow_allow'
  | 'shadow_deny'
  | 'no_applicable'
  | 'unavailable';

interface AccountFixture {
  accountId: string;
  committedUsd: string;
  enforcement: 'hard_stop' | 'advisory';
  limitUsd: string;
  openingCommittedUsd: string;
  period: 'day';
  periodEnd: string;
  periodStart: string;
  reservedUsd: string;
  ruleKey: string;
  ruleRevision: number | null;
  ruleRevisionId: string | null;
  ruleSnapshot: JsonObject;
  ruleSnapshotHash: string;
  scope: 'pooled' | 'per_customer';
  subjectCustomerId: string | null;
  unresolvedUsd: string;
  version: number;
}

interface DecisionFixture {
  account: AccountFixture;
  allocationId: string | null;
  builderId: string;
  costEventId?: string;
  customerId: string;
  decision: 'reserved' | 'denied' | 'bypassed' | 'unavailable';
  decisionId: string;
  expiresAt: string | null;
  operationId: string;
  outboxId?: string;
  pricingSnapshot: JsonObject;
  pricingSnapshotHash: string;
  reservationId: string | null;
  reservedAt: string | null;
  ruleRevisionIds: string[];
  ruleSetHash: string;
  spanId: string;
  traceId: string;
  transitionId?: string;
  usageId?: string;
  usageKind: 'llm' | 'tool';
}

interface DecisionOptions {
  account?: AccountFixture;
  accountVersionBefore?: number;
  allocationIsDeciding?: boolean;
  allocationRuleRevisionId?: string;
  allocationRuleKey?: string;
  allocationStatus?: string;
  beforeCommit?: (tx: TransactionSql) => Promise<void>;
  beforeObservation?: (tx: TransactionSql) => Promise<void>;
  createdAt?: string;
  customerId?: string;
  expiresAtOverride?: string;
  kind?: DecisionKind;
  omitAllocation?: boolean;
  operationId?: string;
  provider?: string;
  requestSnapshotOverride?: JsonObject;
  reserveResponseOverride?: JsonObject;
  requestedUsd?: string;
  ruleRevisionIdsOverride?: string[];
  ruleSetHashOverride?: string;
  transactionIsolation?: 'repeatable read' | 'serializable';
  unavailableDecisionId?: 'matching' | 'null';
  usageKind?: 'llm' | 'tool';
}

interface CommitOptions {
  actualUsd?: string;
  billingRetentionDays?: number;
  committedAt?: string;
  insertOutbox?: boolean;
  insertTransition?: boolean;
  insertUsage?: boolean;
  outboxPayloadOverride?: JsonObject;
  retentionDays?: number;
  retainUntil?: string;
  transitionRequestOverride?: JsonObject;
  transitionResponseOverride?: JsonObject;
  usageActualCostUsd?: string;
  usageCustomerId?: string;
  usagePricingSnapshotOverride?: JsonObject;
  usageStatus?: 'success' | 'failure' | 'retry' | 'aborted';
  usageStreamAborted?: boolean;
}

type RuleRetirementReason = 'superseded' | 'disabled' | 'deleted';

interface RuleRevisionFixture {
  activeFrom: string;
  configSnapshot: JsonObject;
  configSnapshotHash: string;
  enforcement: 'hard_stop' | 'advisory';
  limitUsd: string;
  period: 'hour' | 'day' | 'week' | 'month';
  retiredAt: string | null;
  retirementReason: RuleRetirementReason | null;
  revision: number;
  ruleKey: string;
  ruleRevisionId: string;
  scope: 'pooled' | 'per_customer';
  targetCustomerId: string | null;
}

let scratch: ScratchDb | undefined;

async function migratedScratch(prefix: string): Promise<ScratchDb> {
  const candidate = await createScratchDb({ prefix });
  try {
    await applyMigrationsThrough(candidate, MIGRATION_FILENAME);
    return candidate;
  } catch (error) {
    await candidate.drop();
    throw error;
  }
}

beforeAll(async () => {
  scratch = await migratedScratch('authoritative_budget_ledger');
});

afterAll(async () => {
  await scratch?.drop();
});

function db(): Db {
  if (!scratch) throw new Error('authoritative budget ledger scratch database is not ready');
  return scratch.sql;
}

async function useBuilder(sql: LedgerSql, builderId: string): Promise<void> {
  await sql`SELECT set_config('app.builder_id', ${builderId}, false)`;
}

async function useOutboxWorker(sql: TransactionSql, workerId: string): Promise<void> {
  await sql`SELECT set_config('app.outbox_worker_id', ${workerId}, true)`;
}

async function jsonHash(sql: LedgerSql, value: JsonObject): Promise<string> {
  const [row] = await sql<{ hash: string }[]>`
    SELECT public.pylva_budget_jsonb_sha256(${sql.json(value)}::jsonb) AS hash
  `;
  return row!.hash;
}

async function transactionTimestamp(sql: LedgerSql): Promise<string> {
  const [row] = await sql<{ value: Date }[]>`
    SELECT transaction_timestamp() AS value
  `;
  return row!.value.toISOString();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1_000).toISOString();
}

function addDays(iso: string, days: number): string {
  return addSeconds(iso, days * 86_400);
}

async function canonicalDecimal(sql: LedgerSql, value: string): Promise<string> {
  const [row] = await sql<{ value: string }[]>`
    SELECT public.pylva_budget_decimal_text(${value}::numeric) AS value
  `;
  return row!.value;
}

async function insertBuilder(
  sql: Db,
  label: string,
  tier: 'enterprise' | 'pro' | 'scale' = 'pro',
): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 35);
  const [builder] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (
      ${`${safeLabel}-${suffix}@example.com`},
      ${label},
      ${tier},
      ${`${safeLabel}-${suffix}`}
    )
    RETURNING id
  `;
  return builder!.id;
}

async function insertAccount(
  sql: Db,
  builderId: string,
  overrides: Partial<{
    accountId: string;
    enforcement: 'hard_stop' | 'advisory';
    initialCommittedUsd: string;
    initialReservedUsd: string;
    initialUnresolvedUsd: string;
    limitUsd: string;
    openingCommittedUsd: string;
    periodEnd: string;
    periodStart: string;
    ruleKey: string;
    ruleSnapshotOverride: JsonObject;
    scope: 'pooled' | 'per_customer';
    subjectCustomerId: string | null;
    targetCustomerId: string | null;
  }> = {},
): Promise<AccountFixture> {
  return sql.begin(async (tx) => {
    await useBuilder(tx, builderId);
    const accountId = overrides.accountId ?? crypto.randomUUID();
    const ruleKey = overrides.ruleKey ?? crypto.randomUUID();
    const [existingRevision] = await tx<{ id: string }[]>`
      SELECT id
      FROM budget_rule_revisions
      WHERE builder_id = ${builderId} AND rule_key = ${ruleKey} AND retired_at IS NULL
    `;
    const activeRevision = existingRevision
      ? await loadRuleRevision(tx, builderId, existingRevision.id)
      : await insertInitialRuleRevision(tx, builderId, {
          enforcement: overrides.enforcement ?? 'hard_stop',
          limitUsd: overrides.limitUsd ?? '10',
          ruleKey,
          scope: overrides.scope ?? 'pooled',
          targetCustomerId:
            overrides.targetCustomerId === undefined ? null : overrides.targetCustomerId,
        });
    const enforcement = overrides.enforcement ?? activeRevision.enforcement;
    const limitUsd = overrides.limitUsd ?? activeRevision.limitUsd;
    const openingCommittedUsd = overrides.openingCommittedUsd ?? '0';
    const initialCommittedUsd = overrides.initialCommittedUsd ?? openingCommittedUsd;
    const initialReservedUsd = overrides.initialReservedUsd ?? '0';
    const initialUnresolvedUsd = overrides.initialUnresolvedUsd ?? '0';
    const scope = overrides.scope ?? activeRevision.scope;
    const subjectCustomerId =
      overrides.subjectCustomerId === undefined ? null : overrides.subjectCustomerId;
    const [currentPeriod] = await tx<{ period_end: Date; period_start: Date }[]>`
      SELECT date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC')
               AT TIME ZONE 'UTC' AS period_start,
             (date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC')
               + INTERVAL '1 day') AT TIME ZONE 'UTC' AS period_end
    `;
    const periodStart = overrides.periodStart ?? currentPeriod!.period_start.toISOString();
    const periodEnd = overrides.periodEnd ?? currentPeriod!.period_end.toISOString();
    const ruleSnapshot = {
      schema_version: '1.0',
      rule_key: ruleKey,
      enforcement,
      limit_usd: limitUsd,
      scope,
      subject_customer_id: subjectCustomerId,
      period: 'day',
      period_start: periodStart,
      period_end: periodEnd,
      opening_committed_usd: openingCommittedUsd,
      ...overrides.ruleSnapshotOverride,
    };
    const ruleSnapshotHash = await jsonHash(tx, ruleSnapshot);

    await tx`
      INSERT INTO budget_accounts (
        builder_id, id, rule_key, enforcement, limit_usd, scope,
        subject_customer_id, period, period_start, period_end,
        initial_rule_revision_id, initial_rule_snapshot, initial_rule_snapshot_hash,
        opening_committed_usd, committed_usd, reserved_usd, unresolved_usd
      )
      VALUES (
        ${builderId}, ${accountId}, ${ruleKey}, ${enforcement}, ${limitUsd}, ${scope},
        ${subjectCustomerId}, 'day', ${periodStart}, ${periodEnd},
        ${activeRevision.ruleRevisionId}, ${tx.json(ruleSnapshot)}, ${ruleSnapshotHash},
        ${openingCommittedUsd}, ${initialCommittedUsd},
        ${initialReservedUsd}, ${initialUnresolvedUsd}
      )
    `;

    return loadAccount(tx, builderId, accountId);
  });
}

async function loadAccount(
  sql: LedgerSql,
  builderId: string,
  accountId: string,
): Promise<AccountFixture> {
  const [row] = await sql<
    {
      committed_usd: string;
      enforcement: 'hard_stop' | 'advisory';
      id: string;
      initial_rule_snapshot: JsonObject;
      initial_rule_snapshot_hash: string;
      limit_usd: string;
      opening_committed_usd: string;
      period: 'day';
      period_end: Date;
      period_start: Date;
      reserved_usd: string;
      rule_key: string;
      rule_revision: string | null;
      rule_revision_id: string | null;
      rule_snapshot: JsonObject | null;
      rule_snapshot_hash: string | null;
      revision_enforcement: 'hard_stop' | 'advisory' | null;
      revision_limit_usd: string | null;
      scope: 'pooled' | 'per_customer';
      subject_customer_id: string | null;
      unresolved_usd: string;
      version: string;
    }[]
  >`
    SELECT account.id, account.rule_key, account.enforcement,
           public.pylva_budget_decimal_text(account.limit_usd) AS limit_usd,
           account.scope, account.subject_customer_id, account.period,
           account.period_start, account.period_end, account.initial_rule_snapshot,
           account.initial_rule_snapshot_hash, account.opening_committed_usd::text,
           account.committed_usd::text, account.reserved_usd::text,
           account.unresolved_usd::text, account.version::text,
           revision.id AS rule_revision_id, revision.revision::text AS rule_revision,
           CASE WHEN revision.id IS NULL THEN account.initial_rule_snapshot ELSE
             jsonb_build_object(
               'schema_version', '1.0',
               'rule_key', account.rule_key::text,
               'scope', account.scope,
               'subject_customer_id', account.subject_customer_id,
               'period', account.period,
               'period_start', public.pylva_budget_timestamp_text(account.period_start),
               'period_end', public.pylva_budget_timestamp_text(account.period_end),
               'enforcement', revision.enforcement,
               'limit_usd', public.pylva_budget_decimal_text(revision.limit_usd),
               'opening_committed_usd',
                 public.pylva_budget_decimal_text(account.opening_committed_usd)
             )
           END AS rule_snapshot,
           public.pylva_budget_jsonb_sha256(
             CASE WHEN revision.id IS NULL THEN account.initial_rule_snapshot ELSE
               jsonb_build_object(
                 'schema_version', '1.0',
                 'rule_key', account.rule_key::text,
                 'scope', account.scope,
                 'subject_customer_id', account.subject_customer_id,
                 'period', account.period,
                 'period_start', public.pylva_budget_timestamp_text(account.period_start),
                 'period_end', public.pylva_budget_timestamp_text(account.period_end),
                 'enforcement', revision.enforcement,
                 'limit_usd', public.pylva_budget_decimal_text(revision.limit_usd),
                 'opening_committed_usd',
                   public.pylva_budget_decimal_text(account.opening_committed_usd)
               )
             END
           ) AS rule_snapshot_hash,
           revision.enforcement AS revision_enforcement,
           public.pylva_budget_decimal_text(revision.limit_usd) AS revision_limit_usd
    FROM budget_accounts account
    LEFT JOIN LATERAL (
      SELECT candidate.id, candidate.revision, candidate.enforcement, candidate.limit_usd
      FROM budget_rule_revisions candidate
      WHERE candidate.builder_id = account.builder_id
        AND candidate.rule_key = account.rule_key
        AND candidate.retired_at IS NULL
      ORDER BY candidate.revision DESC
      LIMIT 1
    ) revision ON TRUE
    WHERE account.builder_id = ${builderId} AND account.id = ${accountId}
  `;
  if (!row) throw new Error('budget account fixture disappeared');
  return {
    accountId: row.id,
    committedUsd: row.committed_usd,
    enforcement: row.revision_enforcement ?? row.enforcement,
    limitUsd: row.revision_limit_usd ?? row.limit_usd,
    openingCommittedUsd: row.opening_committed_usd,
    period: row.period,
    periodEnd: row.period_end.toISOString(),
    periodStart: row.period_start.toISOString(),
    reservedUsd: row.reserved_usd,
    ruleKey: row.rule_key,
    ruleRevision: row.rule_revision === null ? null : Number.parseInt(row.rule_revision, 10),
    ruleRevisionId: row.rule_revision_id,
    ruleSnapshot: row.rule_snapshot ?? row.initial_rule_snapshot,
    ruleSnapshotHash: row.rule_snapshot_hash ?? row.initial_rule_snapshot_hash,
    scope: row.scope,
    subjectCustomerId: row.subject_customer_id,
    unresolvedUsd: row.unresolved_usd,
    version: Number.parseInt(row.version, 10),
  };
}

async function loadRuleRevision(
  sql: LedgerSql,
  builderId: string,
  ruleRevisionId: string,
): Promise<RuleRevisionFixture> {
  const [row] = await sql<
    {
      active_from: Date;
      config_snapshot: JsonObject;
      config_snapshot_hash: string;
      enforcement: 'hard_stop' | 'advisory';
      id: string;
      limit_usd: string;
      period: 'hour' | 'day' | 'week' | 'month';
      retired_at: Date | null;
      retirement_reason: RuleRetirementReason | null;
      revision: string;
      rule_key: string;
      scope: 'pooled' | 'per_customer';
      target_customer_id: string | null;
    }[]
  >`
    SELECT id, rule_key, revision::text, scope, target_customer_id, period,
           enforcement, public.pylva_budget_decimal_text(limit_usd) AS limit_usd,
           config_snapshot, config_snapshot_hash,
           active_from, retired_at, retirement_reason
    FROM budget_rule_revisions
    WHERE builder_id = ${builderId} AND id = ${ruleRevisionId}
  `;
  if (!row) throw new Error('budget rule revision fixture disappeared');
  return {
    activeFrom: row.active_from.toISOString(),
    configSnapshot: row.config_snapshot,
    configSnapshotHash: row.config_snapshot_hash,
    enforcement: row.enforcement,
    limitUsd: row.limit_usd,
    period: row.period,
    retiredAt: row.retired_at?.toISOString() ?? null,
    retirementReason: row.retirement_reason,
    revision: Number.parseInt(row.revision, 10),
    ruleKey: row.rule_key,
    ruleRevisionId: row.id,
    scope: row.scope,
    targetCustomerId: row.target_customer_id,
  };
}

async function loadLatestRuleRevision(
  sql: LedgerSql,
  builderId: string,
  ruleKey: string,
): Promise<RuleRevisionFixture> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM budget_rule_revisions
    WHERE builder_id = ${builderId} AND rule_key = ${ruleKey}
    ORDER BY revision DESC
    LIMIT 1
  `;
  if (!row) throw new Error('budget rule has no revision history');
  return loadRuleRevision(sql, builderId, row.id);
}

async function insertInitialRuleRevision(
  sql: LedgerSql,
  builderId: string,
  values: {
    enforcement: 'hard_stop' | 'advisory';
    limitUsd: string;
    ruleKey: string;
    scope: 'pooled' | 'per_customer';
    targetCustomerId: string | null;
  },
): Promise<RuleRevisionFixture> {
  const configSnapshot = {
    schema_version: '1.0',
    rule_key: values.ruleKey,
    scope: values.scope,
    target_customer_id: values.targetCustomerId,
    period: 'day',
    enforcement: values.enforcement,
    limit_usd: values.limitUsd,
  };
  const configSnapshotHash = await jsonHash(sql, configSnapshot);
  const ruleRevisionId = crypto.randomUUID();
  await sql`
    INSERT INTO budget_rule_revisions (
      builder_id, id, rule_key, revision, scope, target_customer_id, period,
      enforcement, limit_usd, config_snapshot, config_snapshot_hash
    )
    VALUES (
      ${builderId}, ${ruleRevisionId}, ${values.ruleKey}, 0, ${values.scope},
      ${values.targetCustomerId}, 'day', ${values.enforcement}, ${values.limitUsd},
      ${sql.json(configSnapshot)}, ${configSnapshotHash}
    )
  `;
  return loadRuleRevision(sql, builderId, ruleRevisionId);
}

async function retireRuleRevision(
  sql: LedgerSql,
  builderId: string,
  ruleRevisionId: string,
  retirementReason: RuleRetirementReason,
): Promise<RuleRevisionFixture> {
  await sql`
    UPDATE budget_rule_revisions
    SET retirement_reason = ${retirementReason}
    WHERE builder_id = ${builderId} AND id = ${ruleRevisionId}
  `;
  return loadRuleRevision(sql, builderId, ruleRevisionId);
}

async function insertRuleRevision(
  sql: LedgerSql,
  builderId: string,
  previousRevision: RuleRevisionFixture,
  overrides: Partial<{
    enforcement: 'hard_stop' | 'advisory';
    limitUsd: string;
    period: 'hour' | 'day' | 'week' | 'month';
    scope: 'pooled' | 'per_customer';
    targetCustomerId: string | null;
    configSnapshotOverride: JsonObject;
  }> = {},
): Promise<RuleRevisionFixture> {
  const enforcement = overrides.enforcement ?? previousRevision.enforcement;
  const limitUsd = overrides.limitUsd ?? previousRevision.limitUsd;
  const scope = overrides.scope ?? previousRevision.scope;
  const targetCustomerId =
    overrides.targetCustomerId === undefined
      ? previousRevision.targetCustomerId
      : overrides.targetCustomerId;
  const period = overrides.period ?? previousRevision.period;
  const configSnapshot = {
    schema_version: '1.0',
    rule_key: previousRevision.ruleKey,
    scope,
    target_customer_id: targetCustomerId,
    period,
    enforcement,
    limit_usd: limitUsd,
    ...overrides.configSnapshotOverride,
  };
  const configSnapshotHash = await jsonHash(sql, configSnapshot);
  const ruleRevisionId = crypto.randomUUID();
  await sql`
    INSERT INTO budget_rule_revisions (
      builder_id, id, rule_key, revision, scope, target_customer_id, period,
      enforcement, limit_usd, config_snapshot, config_snapshot_hash
    )
    VALUES (
      ${builderId}, ${ruleRevisionId}, ${previousRevision.ruleKey}, 0, ${scope},
      ${targetCustomerId}, ${period}, ${enforcement}, ${limitUsd},
      ${sql.json(configSnapshot)}, ${configSnapshotHash}
    )
  `;
  return loadRuleRevision(sql, builderId, ruleRevisionId);
}

async function rotateRuleRevision(
  sql: Db,
  builderId: string,
  ruleKey: string,
  overrides: Parameters<typeof insertRuleRevision>[3] = {},
): Promise<{ retired: RuleRevisionFixture; successor: RuleRevisionFixture }> {
  return sql.begin(async (tx) => {
    await useBuilder(tx, builderId);
    const current = await loadLatestRuleRevision(tx, builderId, ruleKey);
    const retired = await retireRuleRevision(tx, builderId, current.ruleRevisionId, 'superseded');
    const successor = await insertRuleRevision(tx, builderId, current, overrides);
    return { retired, successor };
  });
}

async function seedDecision(
  sql: Db,
  builderId: string,
  options: DecisionOptions = {},
): Promise<DecisionFixture> {
  const account =
    options.account ??
    (await insertAccount(sql, builderId, {
      limitUsd: options.kind === 'denied' || options.kind === 'shadow_deny' ? '0' : '10',
    }));
  await useBuilder(sql, builderId);

  const execute = async (tx: TransactionSql): Promise<DecisionFixture> => {
    await useBuilder(tx, builderId);
    await options.beforeObservation?.(tx);
    const observed = await loadAccount(tx, builderId, account.accountId);
    const kind = options.kind ?? 'reserved';
    const decision =
      kind === 'reserved'
        ? 'reserved'
        : kind === 'denied'
          ? 'denied'
          : kind === 'unavailable'
            ? 'unavailable'
            : 'bypassed';
    const mode = kind.startsWith('shadow') ? 'shadow' : 'enforce';
    const decisionReason =
      kind === 'denied'
        ? 'budget_exceeded'
        : kind === 'shadow_allow'
          ? 'shadow_would_allow'
          : kind === 'shadow_deny'
            ? 'shadow_would_deny'
            : kind === 'no_applicable'
              ? 'no_applicable_budget'
              : kind === 'unavailable'
                ? 'control_unavailable'
                : null;
    const wouldHaveDenied = kind === 'shadow_allow' ? false : kind === 'shadow_deny' ? true : null;
    const decisionId = crypto.randomUUID();
    const operationId = options.operationId ?? crypto.randomUUID();
    const reservationId = kind === 'reserved' ? crypto.randomUUID() : null;
    const customerId = options.customerId ?? 'customer_1';
    const usageKind = options.usageKind ?? 'llm';
    const provider = options.provider ?? 'openai';
    const traceId = crypto.randomUUID();
    const spanId = crypto.randomUUID();
    const createdAt = options.createdAt ?? observed.periodStart;
    const reservedAt = kind === 'reserved' ? createdAt : null;
    const expiresAt =
      kind === 'reserved' ? (options.expiresAtOverride ?? addSeconds(createdAt, 300)) : null;
    const refusedAt = kind === 'denied' ? createdAt : null;
    const requestedUsd = options.requestedUsd ?? '1';
    const [arithmetic] = await tx<
      {
        committed_usd: string;
        exceeds_limit: boolean;
        limit_usd: string;
        projected_usd: string;
        remaining_usd: string;
        requested_usd: string;
        reserved_usd: string;
        unresolved_usd: string;
      }[]
    >`
      WITH amounts AS (
        SELECT ${observed.committedUsd}::numeric AS committed_usd,
               ${observed.reservedUsd}::numeric AS reserved_usd,
               ${observed.unresolvedUsd}::numeric AS unresolved_usd,
               ${requestedUsd}::numeric AS requested_usd,
               ${observed.limitUsd}::numeric AS limit_usd
      ), totals AS (
        SELECT *, committed_usd + reserved_usd + unresolved_usd + requested_usd
                    AS projected_usd
        FROM amounts
      )
      SELECT public.pylva_budget_decimal_text(committed_usd) AS committed_usd,
             public.pylva_budget_decimal_text(reserved_usd) AS reserved_usd,
             public.pylva_budget_decimal_text(unresolved_usd) AS unresolved_usd,
             public.pylva_budget_decimal_text(requested_usd) AS requested_usd,
             public.pylva_budget_decimal_text(limit_usd) AS limit_usd,
             public.pylva_budget_decimal_text(projected_usd) AS projected_usd,
             public.pylva_budget_decimal_text(
               CASE
                 WHEN projected_usd <= limit_usd THEN limit_usd - projected_usd
                 ELSE GREATEST(
                   limit_usd - committed_usd - reserved_usd - unresolved_usd,
                   0
                 )
               END
             ) AS remaining_usd,
             projected_usd > limit_usd AS exceeds_limit
      FROM totals
    `;
    const projectedUsd = arithmetic!.projected_usd;
    const remainingUsd = arithmetic!.remaining_usd;
    const reservationRemainingUsd = observed.enforcement === 'hard_stop' ? remainingUsd : null;
    const warnings =
      observed.enforcement === 'advisory' && arithmetic!.exceeds_limit
        ? [
            {
              code: 'advisory_budget_exceeded',
              rule_id: observed.ruleKey,
              limit_usd: arithmetic!.limit_usd,
              projected_usd: projectedUsd,
            },
          ]
        : [];
    const allocationStatus =
      options.allocationStatus ??
      (kind === 'reserved' ? 'reserved' : kind === 'denied' ? 'refused' : 'shadow');
    const allocationIsDeciding =
      options.allocationIsDeciding ?? (kind === 'denied' || kind === 'shadow_deny');
    const decidingAccountId = allocationIsDeciding ? observed.accountId : null;
    const pricingSnapshot =
      usageKind === 'llm' ? { ...PRICING_SNAPSHOT } : { ...TOOL_PRICING_SNAPSHOT };
    const pricingSnapshotHash = await jsonHash(tx, pricingSnapshot);
    const requestBase = {
      schema_version: '1.0',
      mode,
      operation_id: operationId,
      customer_id: customerId,
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: null,
      step_name: 'agent.call',
      framework: 'none',
      reservation_ttl_seconds: 300,
      kind: usageKind,
    };
    const requestSnapshot = {
      ...requestBase,
      ...(usageKind === 'llm'
        ? {
            provider,
            model: 'gpt-4o-mini',
            estimated_input_tokens: 100,
            max_output_tokens: 50,
          }
        : {
            cost_source_slug: 'tavily-search',
            tool_name: 'tavily_search',
            metric: 'credit',
            maximum_value: '1',
          }),
      ...options.requestSnapshotOverride,
    };
    const requestHash = await jsonHash(tx, requestSnapshot);

    let reserveResponse: JsonObject;
    if (kind === 'reserved') {
      reserveResponse = {
        schema_version: '1.0',
        decision: 'reserved',
        allowed: true,
        decision_id: decisionId,
        operation_id: operationId,
        reservation_id: reservationId,
        state: 'reserved',
        reserved_usd: arithmetic!.requested_usd,
        remaining_usd: reservationRemainingUsd,
        expires_at: expiresAt,
        warnings,
      };
    } else if (kind === 'denied') {
      reserveResponse = {
        schema_version: '1.0',
        decision: 'denied',
        allowed: false,
        decision_id: decisionId,
        operation_id: operationId,
        state: 'refused',
        deciding_rule: {
          rule_id: observed.ruleKey,
          scope: observed.scope,
          customer_id: observed.subjectCustomerId,
          period: observed.period,
          period_start: observed.periodStart,
          period_end: observed.periodEnd,
        },
        committed_usd: arithmetic!.committed_usd,
        reserved_usd: arithmetic!.reserved_usd,
        unresolved_usd: arithmetic!.unresolved_usd,
        requested_usd: arithmetic!.requested_usd,
        limit_usd: arithmetic!.limit_usd,
        remaining_usd: remainingUsd,
        warnings,
      };
    } else if (kind.startsWith('shadow') || kind === 'no_applicable') {
      reserveResponse = {
        schema_version: '1.0',
        decision: 'bypassed',
        allowed: true,
        decision_id: decisionId,
        operation_id: operationId,
        reason: decisionReason,
        would_have_denied: wouldHaveDenied,
        warnings,
      };
    } else {
      reserveResponse = {
        schema_version: '1.0',
        decision: 'unavailable',
        allowed: false,
        decision_id: options.unavailableDecisionId === 'matching' ? decisionId : null,
        operation_id: operationId,
        reason: 'control_unavailable',
        retryable: true,
      };
    }
    reserveResponse = { ...reserveResponse, ...options.reserveResponseOverride };

    const [insertedReservation] = await tx<
      {
        expires_at: Date | null;
        reserved_at: Date | null;
        rule_revision_ids: string[];
        rule_set_hash: string;
      }[]
    >`
      INSERT INTO budget_reservations (
        builder_id, decision_id, reservation_id, operation_id, schema_version,
        request_hash, request_snapshot, mode, kind, customer_id, trace_id, span_id,
        parent_span_id, step_name, framework, reservation_ttl_seconds,
        provider, model, estimated_input_tokens, max_output_tokens,
        cost_source_slug, tool_name, metric, maximum_value,
        decision, decision_reason, would_have_denied, state,
        pricing_snapshot, pricing_snapshot_hash, requested_usd, reserved_usd,
        actual_usd, released_usd, overage_usd, remaining_usd,
        deciding_account_id, reserve_response_snapshot,
        rule_revision_ids, rule_set_hash,
        expires_at, reserved_at, refused_at, created_at, updated_at
      )
      VALUES (
        ${builderId}, ${decisionId}, ${reservationId}, ${operationId}, '1.0',
        ${requestHash}, ${tx.json(requestSnapshot)}, ${mode}, ${usageKind}, ${customerId},
        ${traceId}, ${spanId}, NULL, 'agent.call', 'none', 300,
        ${usageKind === 'llm' ? provider : null},
        ${usageKind === 'llm' ? 'gpt-4o-mini' : null},
        ${usageKind === 'llm' ? 100 : null}, ${usageKind === 'llm' ? 50 : null},
        ${usageKind === 'tool' ? 'tavily-search' : null},
        ${usageKind === 'tool' ? 'tavily_search' : null},
        ${usageKind === 'tool' ? 'credit' : null},
        ${usageKind === 'tool' ? '1' : null},
        ${decision}, ${decisionReason}, ${wouldHaveDenied},
        ${kind === 'reserved' ? 'reserved' : kind === 'denied' ? 'refused' : null},
        ${tx.json(pricingSnapshot)}, ${pricingSnapshotHash}, ${requestedUsd},
        ${kind === 'reserved' ? requestedUsd : '0'}, '0', '0', '0',
        ${reservationRemainingUsd},
        ${decidingAccountId}, ${tx.json(reserveResponse)},
        ${options.ruleRevisionIdsOverride ?? []}::uuid[],
        ${options.ruleSetHashOverride ?? '0'.repeat(64)},
        ${expiresAt}, ${reservedAt}, ${refusedAt}, ${createdAt}, ${createdAt}
      )
      RETURNING reserved_at, expires_at, rule_revision_ids, rule_set_hash
    `;

    let allocationId: string | null = null;
    if (!options.omitAllocation && kind !== 'unavailable' && kind !== 'no_applicable') {
      if (!observed.ruleRevisionId) {
        throw new Error('an evaluated decision requires an active rule revision');
      }
      allocationId = crypto.randomUUID();
      await tx`
        INSERT INTO budget_reservation_allocations (
          builder_id, id, reservation_decision_id, account_id, rule_key, rule_revision_id,
          rule_snapshot, rule_snapshot_hash, enforcement, evaluation_order,
          is_deciding, account_version_before, held_at_reserve, status,
          committed_before_usd, reserved_before_usd, unresolved_before_usd,
          requested_usd, projected_usd, limit_usd, remaining_usd,
          authorized_usd, actual_usd, released_usd, unresolved_usd, overage_usd,
          created_at, updated_at
        )
        VALUES (
          ${builderId}, ${allocationId}, ${decisionId}, ${observed.accountId},
          ${options.allocationRuleKey ?? observed.ruleKey},
          ${options.allocationRuleRevisionId ?? observed.ruleRevisionId},
          ${tx.json(observed.ruleSnapshot)}, ${observed.ruleSnapshotHash},
          ${observed.enforcement}, 0, ${allocationIsDeciding},
          ${options.accountVersionBefore ?? observed.version},
          ${kind === 'reserved'}, ${allocationStatus},
          ${observed.committedUsd}, ${observed.reservedUsd}, ${observed.unresolvedUsd},
          ${requestedUsd}, ${projectedUsd}, ${observed.limitUsd}, ${remainingUsd},
          ${kind === 'reserved' ? requestedUsd : '0'}, '0', '0', '0', '0',
          ${createdAt}, ${createdAt}
        )
      `;
    }

    await options.beforeCommit?.(tx);

    return {
      account: observed,
      allocationId,
      builderId,
      customerId,
      decision,
      decisionId,
      expiresAt: insertedReservation!.expires_at?.toISOString() ?? null,
      operationId,
      pricingSnapshot,
      pricingSnapshotHash,
      reservationId,
      reservedAt: insertedReservation!.reserved_at?.toISOString() ?? null,
      ruleRevisionIds: insertedReservation!.rule_revision_ids,
      ruleSetHash: insertedReservation!.rule_set_hash,
      spanId,
      traceId,
      usageKind,
    };
  };
  return options.transactionIsolation
    ? sql.begin(`isolation level ${options.transactionIsolation}`, execute)
    : sql.begin(execute);
}

async function loadLifecycle(
  sql: LedgerSql,
  fixture: DecisionFixture,
): Promise<{
  expiresAt: string;
  reservedUsd: string;
  state: 'reserved' | 'unresolved';
  stateVersion: number;
}> {
  const [row] = await sql<
    {
      expires_at: Date;
      reserved_usd: string;
      state: 'reserved' | 'unresolved';
      state_version: string;
    }[]
  >`
    SELECT expires_at, reserved_usd::text, state, state_version::text
    FROM budget_reservations
    WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
  `;
  if (!row?.expires_at || !row.state) throw new Error('reservation is not lifecycle-active');
  return {
    expiresAt: row.expires_at.toISOString(),
    reservedUsd: row.reserved_usd,
    state: row.state,
    stateVersion: Number.parseInt(row.state_version, 10),
  };
}

async function insertExactOutbox(
  tx: TransactionSql,
  fixture: DecisionFixture,
  usageId: string,
  costEventId: string,
  payloadOverride?: JsonObject,
): Promise<string> {
  const [projected] = await tx<{ payload: JsonObject }[]>`
    SELECT public.pylva_budget_cost_event_payload(usage) AS payload
    FROM budget_usage_ledger usage
    WHERE usage.builder_id = ${fixture.builderId} AND usage.id = ${usageId}
  `;
  if (!projected) throw new Error('usage payload projection is unavailable');
  const payload = payloadOverride
    ? { ...projected.payload, ...payloadOverride }
    : projected.payload;
  const payloadHash = await jsonHash(tx, payload);
  const outboxId = crypto.randomUUID();
  await tx`
    INSERT INTO budget_cost_event_outbox (
      builder_id, id, usage_ledger_id, cost_event_id,
      payload_schema_version, payload, payload_hash
    )
    VALUES (
      ${fixture.builderId}, ${outboxId}, ${usageId}, ${costEventId},
      '1.6', ${tx.json(payload)}, ${payloadHash}
    )
  `;
  return outboxId;
}

async function commitReservation(
  sql: Db,
  fixture: DecisionFixture,
  options: CommitOptions = {},
): Promise<DecisionFixture> {
  if (!fixture.allocationId || !fixture.reservationId) {
    throw new Error('only a held reservation can be committed');
  }
  await useBuilder(sql, fixture.builderId);
  return sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    const lifecycle = await loadLifecycle(tx, fixture);
    const requestedCommittedAt = options.committedAt ?? (await transactionTimestamp(tx));
    const actualUsd = options.actualUsd ?? '0.75';
    const [settlement] = await tx<
      {
        actual_usd: string;
        overage_usd: string;
        released_usd: string;
        reserved_usd: string;
      }[]
    >`
      WITH amounts AS (
        SELECT ${lifecycle.reservedUsd}::numeric AS reserved_usd,
               ${actualUsd}::numeric AS actual_usd
      )
      SELECT public.pylva_budget_decimal_text(reserved_usd) AS reserved_usd,
             public.pylva_budget_decimal_text(actual_usd) AS actual_usd,
             public.pylva_budget_decimal_text(
               GREATEST(reserved_usd - actual_usd, 0)
             ) AS released_usd,
             public.pylva_budget_decimal_text(
               GREATEST(actual_usd - reserved_usd, 0)
             ) AS overage_usd
      FROM amounts
    `;
    const releasedUsd = settlement!.released_usd;
    const overageUsd = settlement!.overage_usd;

    const [updatedReservation] = await tx<{ committed_at: Date }[]>`
      UPDATE budget_reservations
      SET state = 'committed', actual_usd = ${actualUsd}, released_usd = ${releasedUsd},
          overage_usd = ${overageUsd}, committed_at = ${requestedCommittedAt},
          unresolved_at = NULL, unresolved_reason = NULL,
          state_version = state_version + 1, updated_at = ${requestedCommittedAt}
      WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
      RETURNING committed_at
    `;
    await tx`
      UPDATE budget_reservation_allocations
      SET status = 'committed', actual_usd = ${actualUsd}, released_usd = ${releasedUsd},
          unresolved_usd = '0', overage_usd = ${overageUsd},
          updated_at = ${requestedCommittedAt}
      WHERE builder_id = ${fixture.builderId}
        AND reservation_decision_id = ${fixture.decisionId}
    `;
    const committedAt = updatedReservation!.committed_at.toISOString();
    const [budgetResult] = await tx<{ budget_exceeded_after_commit: boolean }[]>`
      SELECT COALESCE(BOOL_OR(
        allocation.enforcement = 'hard_stop'
        AND account.committed_usd
          + account.reserved_usd
          + account.unresolved_usd > allocation.limit_usd
      ), FALSE) AS budget_exceeded_after_commit
      FROM budget_reservation_allocations allocation
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id
       AND account.id = allocation.account_id
      WHERE allocation.builder_id = ${fixture.builderId}
        AND allocation.reservation_decision_id = ${fixture.decisionId}
    `;

    const usageStatus = options.usageStatus ?? 'success';
    const usageStreamAborted = options.usageStreamAborted ?? false;
    const usageSnapshot =
      fixture.usageKind === 'llm'
        ? {
            schema_version: '1.0',
            status: usageStatus,
            latency_ms: 250,
            stream_aborted: usageStreamAborted,
            kind: 'llm',
            actual_input_tokens: 100,
            actual_output_tokens: 50,
          }
        : {
            schema_version: '1.0',
            status: usageStatus,
            latency_ms: 250,
            stream_aborted: usageStreamAborted,
            kind: 'tool',
            actual_value: '1',
          };
    const usageSnapshotHash = await jsonHash(tx, usageSnapshot);
    const usagePricingSnapshot = options.usagePricingSnapshotOverride ?? fixture.pricingSnapshot;
    const usagePricingSnapshotHash = await jsonHash(tx, usagePricingSnapshot);
    const usageId = crypto.randomUUID();
    const costEventId = crypto.randomUUID();
    const retentionDays = options.retentionDays ?? 90;
    const billingRetentionDays = options.billingRetentionDays ?? 365;
    const retainUntil = options.retainUntil ?? addDays(committedAt, billingRetentionDays);

    if (options.insertUsage !== false) {
      await tx`
        INSERT INTO budget_usage_ledger (
        builder_id, id, reservation_decision_id, operation_id, cost_event_id,
        customer_id, trace_id, span_id, parent_span_id, step_name, framework,
        sdk_version, sdk_language, kind, provider, model,
        actual_input_tokens, actual_output_tokens,
        cost_source_slug, tool_name, metric, actual_value,
        status, latency_ms, stream_aborted, actual_cost_usd,
        pricing_snapshot, pricing_snapshot_hash, usage_snapshot, usage_snapshot_hash,
        cost_source, instrumentation_tier, is_demo,
        retention_days, billing_retention_days, metadata,
        committed_at, retain_until, created_at
        )
        VALUES (
        ${fixture.builderId}, ${usageId}, ${fixture.decisionId}, ${fixture.operationId},
        ${costEventId}, ${options.usageCustomerId ?? fixture.customerId},
        ${fixture.traceId}, ${fixture.spanId},
        NULL, 'agent.call', 'none', '1.2.0', 'typescript', ${fixture.usageKind},
        ${fixture.usageKind === 'llm' ? 'openai' : null},
        ${fixture.usageKind === 'llm' ? 'gpt-4o-mini' : null},
        ${fixture.usageKind === 'llm' ? 100 : null},
        ${fixture.usageKind === 'llm' ? 50 : null},
        ${fixture.usageKind === 'tool' ? 'tavily-search' : null},
        ${fixture.usageKind === 'tool' ? 'tavily_search' : null},
        ${fixture.usageKind === 'tool' ? 'credit' : null},
        ${fixture.usageKind === 'tool' ? '1' : null},
        ${usageStatus}, 250, ${usageStreamAborted}, ${options.usageActualCostUsd ?? actualUsd},
        ${tx.json(usagePricingSnapshot)}, ${usagePricingSnapshotHash},
        ${tx.json(usageSnapshot)}, ${usageSnapshotHash},
        ${fixture.usageKind === 'llm' ? 'auto' : 'configured'},
        ${fixture.usageKind === 'llm' ? 'sdk_wrapper' : 'reported'},
        false, ${retentionDays}, ${billingRetentionDays},
        ${tx.json(
          fixture.usageKind === 'llm' ? { token_count_source: 'exact', finish_reason: 'stop' } : {},
        )},
        ${committedAt}, ${retainUntil}, ${committedAt}
        )
      `;
    }

    const transitionRequest = {
      ...usageSnapshot,
      ...options.transitionRequestOverride,
    };
    const transitionRequestHash = await jsonHash(tx, transitionRequest);
    const transitionResponse = {
      schema_version: '1.0',
      state: 'committed',
      reservation_id: fixture.reservationId,
      operation_id: fixture.operationId,
      reserved_usd: settlement!.reserved_usd,
      actual_usd: settlement!.actual_usd,
      released_usd: releasedUsd,
      overage_usd: overageUsd,
      budget_exceeded_after_commit: budgetResult!.budget_exceeded_after_commit,
      committed_at: committedAt,
      idempotent_replay: false,
      late: lifecycle.state === 'unresolved',
      ...options.transitionResponseOverride,
    };
    const transitionId = options.insertTransition === false ? undefined : crypto.randomUUID();
    if (transitionId) {
      await tx`
        INSERT INTO budget_reservation_transitions (
          builder_id, id, reservation_decision_id, type, extension_id, release_reason,
          request_hash, request_snapshot, response_snapshot,
          from_state, to_state, from_state_version, to_state_version,
          from_expires_at, to_expires_at, extend_by_seconds, occurred_at
        )
        VALUES (
          ${fixture.builderId}, ${transitionId}, ${fixture.decisionId}, 'commit', NULL, NULL,
          ${transitionRequestHash}, ${tx.json(transitionRequest)}, ${tx.json(transitionResponse)},
          ${lifecycle.state}, 'committed', ${lifecycle.stateVersion},
          ${lifecycle.stateVersion + 1}, ${lifecycle.expiresAt}, ${lifecycle.expiresAt},
          NULL, ${committedAt}
        )
      `;
    }

    const outboxId =
      options.insertUsage === false || options.insertOutbox === false
        ? undefined
        : await insertExactOutbox(tx, fixture, usageId, costEventId, options.outboxPayloadOverride);

    return { ...fixture, costEventId, outboxId, transitionId, usageId };
  });
}

async function releaseReservation(
  sql: Db,
  fixture: DecisionFixture,
  requestedOccurredAt?: string,
): Promise<DecisionFixture> {
  if (!fixture.allocationId || !fixture.reservationId) {
    throw new Error('only a held reservation can be released');
  }
  await useBuilder(sql, fixture.builderId);
  return sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    const lifecycle = await loadLifecycle(tx, fixture);
    const occurredAt = requestedOccurredAt ?? (await transactionTimestamp(tx));
    const releasedUsd = await canonicalDecimal(tx, lifecycle.reservedUsd);
    await tx`
      UPDATE budget_reservations
      SET state = 'released', actual_usd = '0', released_usd = reserved_usd,
          overage_usd = '0', released_at = ${occurredAt},
          unresolved_at = NULL, unresolved_reason = NULL,
          state_version = state_version + 1, updated_at = ${occurredAt}
      WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_allocations
      SET status = 'released', actual_usd = '0', released_usd = authorized_usd,
          unresolved_usd = '0', overage_usd = '0', updated_at = ${occurredAt}
      WHERE builder_id = ${fixture.builderId}
        AND reservation_decision_id = ${fixture.decisionId}
    `;
    const requestSnapshot = { schema_version: '1.0', reason: 'provider_not_called' };
    const requestHash = await jsonHash(tx, requestSnapshot);
    const responseSnapshot = {
      schema_version: '1.0',
      state: 'released',
      reservation_id: fixture.reservationId,
      operation_id: fixture.operationId,
      released_usd: releasedUsd,
      released_at: occurredAt,
      idempotent_replay: false,
    };
    const transitionId = crypto.randomUUID();
    await tx`
      INSERT INTO budget_reservation_transitions (
        builder_id, id, reservation_decision_id, type, extension_id, release_reason,
        request_hash, request_snapshot, response_snapshot,
        from_state, to_state, from_state_version, to_state_version,
        from_expires_at, to_expires_at, extend_by_seconds, occurred_at
      )
      VALUES (
        ${fixture.builderId}, ${transitionId}, ${fixture.decisionId}, 'release', NULL,
        'provider_not_called', ${requestHash}, ${tx.json(requestSnapshot)},
        ${tx.json(responseSnapshot)}, ${lifecycle.state}, 'released',
        ${lifecycle.stateVersion}, ${lifecycle.stateVersion + 1},
        ${lifecycle.expiresAt}, ${lifecycle.expiresAt}, NULL, ${occurredAt}
      )
    `;
    return { ...fixture, transitionId };
  });
}

async function expireReservation(sql: Db, fixture: DecisionFixture): Promise<DecisionFixture> {
  if (!fixture.allocationId || !fixture.reservationId) {
    throw new Error('only a held reservation can expire unresolved');
  }
  await useBuilder(sql, fixture.builderId);
  return sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    const lifecycle = await loadLifecycle(tx, fixture);
    const occurredAt = await transactionTimestamp(tx);
    const unresolvedUsd = await canonicalDecimal(tx, lifecycle.reservedUsd);
    await tx`
      UPDATE budget_reservations
      SET state = 'unresolved', unresolved_at = ${occurredAt},
          unresolved_reason = 'lease_expired', state_version = state_version + 1,
          updated_at = ${occurredAt}
      WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_allocations
      SET status = 'unresolved', actual_usd = '0', released_usd = '0',
          unresolved_usd = authorized_usd, overage_usd = '0',
          updated_at = ${occurredAt}
      WHERE builder_id = ${fixture.builderId}
        AND reservation_decision_id = ${fixture.decisionId}
    `;
    const requestSnapshot = { schema_version: '1.0', reason: 'lease_expired' };
    const requestHash = await jsonHash(tx, requestSnapshot);
    const responseSnapshot = {
      schema_version: '1.0',
      state: 'unresolved',
      reservation_id: fixture.reservationId,
      operation_id: fixture.operationId,
      unresolved_usd: unresolvedUsd,
      unresolved_at: occurredAt,
      reason: 'lease_expired',
    };
    const transitionId = crypto.randomUUID();
    await tx`
      INSERT INTO budget_reservation_transitions (
        builder_id, id, reservation_decision_id, type, extension_id, release_reason,
        request_hash, request_snapshot, response_snapshot,
        from_state, to_state, from_state_version, to_state_version,
        from_expires_at, to_expires_at, extend_by_seconds, occurred_at
      )
      VALUES (
        ${fixture.builderId}, ${transitionId}, ${fixture.decisionId},
        'expire_unresolved', NULL, NULL, ${requestHash}, ${tx.json(requestSnapshot)},
        ${tx.json(responseSnapshot)}, 'reserved', 'unresolved',
        ${lifecycle.stateVersion}, ${lifecycle.stateVersion + 1},
        ${lifecycle.expiresAt}, ${lifecycle.expiresAt}, NULL, ${occurredAt}
      )
    `;
    return { ...fixture, transitionId };
  });
}

async function extendReservation(
  sql: Db,
  fixture: DecisionFixture,
  extendBySeconds = 60,
  uppercaseWireIds = false,
): Promise<DecisionFixture> {
  if (!fixture.reservationId) throw new Error('only a reservation can be extended');
  await useBuilder(sql, fixture.builderId);
  return sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    const lifecycle = await loadLifecycle(tx, fixture);
    const extensionId = crypto.randomUUID();
    const nextExpiry = addSeconds(lifecycle.expiresAt, extendBySeconds);
    const occurredAt = await transactionTimestamp(tx);
    await tx`
      UPDATE budget_reservations
      SET expires_at = ${nextExpiry}, state_version = state_version + 1,
          updated_at = ${occurredAt}
      WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
    `;
    const requestSnapshot = {
      schema_version: '1.0',
      extension_id: uppercaseWireIds ? extensionId.toUpperCase() : extensionId,
      extend_by_seconds: extendBySeconds,
    };
    const requestHash = await jsonHash(tx, requestSnapshot);
    const responseSnapshot = {
      schema_version: '1.0',
      state: 'reserved',
      reservation_id: uppercaseWireIds
        ? fixture.reservationId!.toUpperCase()
        : fixture.reservationId,
      operation_id: uppercaseWireIds ? fixture.operationId.toUpperCase() : fixture.operationId,
      extension_id: uppercaseWireIds ? extensionId.toUpperCase() : extensionId,
      expires_at: nextExpiry,
      idempotent_replay: false,
    };
    const transitionId = crypto.randomUUID();
    await tx`
      INSERT INTO budget_reservation_transitions (
        builder_id, id, reservation_decision_id, type, extension_id, release_reason,
        request_hash, request_snapshot, response_snapshot,
        from_state, to_state, from_state_version, to_state_version,
        from_expires_at, to_expires_at, extend_by_seconds, occurred_at
      )
      VALUES (
        ${fixture.builderId}, ${transitionId}, ${fixture.decisionId}, 'extend',
        ${extensionId}, NULL, ${requestHash}, ${tx.json(requestSnapshot)},
        ${tx.json(responseSnapshot)}, 'reserved', 'reserved',
        ${lifecycle.stateVersion}, ${lifecycle.stateVersion + 1},
        ${lifecycle.expiresAt}, ${nextExpiry}, ${extendBySeconds}, ${occurredAt}
      )
    `;
    return { ...fixture, expiresAt: nextExpiry, transitionId };
  });
}

interface OutboxLease {
  lastAttemptAt: string;
  lockedAt: string;
  lockExpiresAt: string;
  lockOwner: string;
}

async function claimOutbox(
  sql: Db,
  fixture: DecisionFixture,
  workerId = 'projection-worker-1',
): Promise<OutboxLease> {
  if (!fixture.outboxId) throw new Error('fixture has no outbox row');
  const outboxId = fixture.outboxId;
  await useBuilder(sql, fixture.builderId);
  return sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    await useOutboxWorker(tx, workerId);
    const [row] = await tx<
      {
        last_attempt_at: Date;
        locked_at: Date;
        lock_expires_at: Date;
        lock_owner: string;
      }[]
    >`
      UPDATE budget_cost_event_outbox
      SET status = 'processing', attempts = attempts + 1,
          locked_at = '2099-01-01T00:00:00.000Z',
          lock_expires_at = '2099-01-01T00:05:00.000Z',
          lock_owner = 'caller-supplied-worker',
          last_attempt_at = '2099-01-01T00:00:00.000Z',
          last_error_code = 'CALLER_ERROR', last_error_message = 'caller error'
      WHERE builder_id = ${fixture.builderId} AND id = ${outboxId}
      RETURNING locked_at, lock_expires_at, lock_owner, last_attempt_at
    `;
    return {
      lastAttemptAt: row!.last_attempt_at.toISOString(),
      lockedAt: row!.locked_at.toISOString(),
      lockExpiresAt: row!.lock_expires_at.toISOString(),
      lockOwner: row!.lock_owner,
    };
  });
}

async function projectClaimedOutbox(
  sql: Db,
  fixture: DecisionFixture,
  workerId = 'projection-worker-1',
): Promise<string> {
  if (!fixture.outboxId) throw new Error('fixture has no outbox row');
  const outboxId = fixture.outboxId;
  await useBuilder(sql, fixture.builderId);
  return sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    await useOutboxWorker(tx, workerId);
    const [row] = await tx<{ projected_at: Date }[]>`
      UPDATE budget_cost_event_outbox
      SET status = 'projected', projected_at = '2099-01-01T00:00:00.000Z'
      WHERE builder_id = ${fixture.builderId} AND id = ${outboxId}
      RETURNING projected_at
    `;
    return row!.projected_at.toISOString();
  });
}

async function projectOutbox(sql: Db, fixture: DecisionFixture): Promise<void> {
  await claimOutbox(sql, fixture);
  await projectClaimedOutbox(sql, fixture);
}

async function verifyOutboxProjection(sql: Db, fixture: DecisionFixture): Promise<void> {
  if (!fixture.outboxId) throw new Error('fixture has no outbox row');
  await useBuilder(sql, fixture.builderId);
  await sql`
    UPDATE budget_cost_event_outbox
    SET projection_verified_at = transaction_timestamp()
    WHERE builder_id = ${fixture.builderId} AND id = ${fixture.outboxId}
  `;
}

async function projectAndVerifyOutbox(sql: Db, fixture: DecisionFixture): Promise<void> {
  await projectOutbox(sql, fixture);
  await verifyOutboxProjection(sql, fixture);
}

async function backdateReservedForExpiry(
  sql: Db,
  fixture: DecisionFixture,
): Promise<DecisionFixture> {
  const pastExpiresAt = addSeconds(PAST_RESERVED_AT, 300);
  await useBuilder(sql, fixture.builderId);
  await sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);

    // This is owner-only setup in a disposable scratch database. Production
    // writers cannot disable the guards or choose lifecycle timestamps.
    await tx`ALTER TABLE budget_accounts DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservations DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservation_allocations DISABLE TRIGGER USER`;
    await tx`
      WITH patched AS (
        SELECT id,
               jsonb_set(
                 jsonb_set(
                   initial_rule_snapshot,
                   '{period_start}',
                   to_jsonb(${PAST_PERIOD_START}::text)
                 ),
                 '{period_end}',
                 to_jsonb(${PAST_PERIOD_END}::text)
               ) AS rule_snapshot
        FROM budget_accounts
        WHERE builder_id = ${fixture.builderId} AND id = ${fixture.account.accountId}
      )
      UPDATE budget_accounts account
      SET period_start = ${PAST_PERIOD_START}, period_end = ${PAST_PERIOD_END},
          initial_rule_snapshot = patched.rule_snapshot,
          initial_rule_snapshot_hash =
            public.pylva_budget_jsonb_sha256(patched.rule_snapshot),
          created_at = ${PAST_RESERVED_AT}, updated_at = ${PAST_RESERVED_AT}
      FROM patched
      WHERE account.builder_id = ${fixture.builderId} AND account.id = patched.id
    `;
    await tx`
      UPDATE budget_reservations
      SET created_at = ${PAST_RESERVED_AT}, updated_at = ${PAST_RESERVED_AT},
          reserved_at = ${PAST_RESERVED_AT}, expires_at = ${pastExpiresAt},
          reserve_response_snapshot = jsonb_set(
            reserve_response_snapshot,
            '{expires_at}',
            to_jsonb(${pastExpiresAt}::text)
          )
      WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_allocations allocation
      SET rule_snapshot = account.initial_rule_snapshot,
          rule_snapshot_hash = account.initial_rule_snapshot_hash,
          created_at = ${PAST_RESERVED_AT}, updated_at = ${PAST_RESERVED_AT}
      FROM budget_accounts account
      WHERE allocation.builder_id = ${fixture.builderId}
        AND allocation.reservation_decision_id = ${fixture.decisionId}
        AND account.builder_id = allocation.builder_id
        AND account.id = allocation.account_id
    `;
    await tx`ALTER TABLE budget_reservation_allocations ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservations ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_accounts ENABLE TRIGGER USER`;

    await tx`
      SELECT public.pylva_budget_assert_reservation_snapshots(
        ${fixture.builderId}, ${fixture.decisionId}
      )
    `;
    await tx`
      SELECT public.pylva_budget_assert_reservation_allocations(
        ${fixture.builderId}, ${fixture.decisionId}, FALSE
      )
    `;
    await tx`
      SELECT public.pylva_budget_assert_account_postings(
        ${fixture.builderId}, ${fixture.account.accountId}
      )
    `;
  });
  const account = await loadAccount(sql, fixture.builderId, fixture.account.accountId);
  return {
    ...fixture,
    account,
    expiresAt: pastExpiresAt,
    reservedAt: PAST_RESERVED_AT,
  };
}

async function moveReservedNearExpiry(sql: Db, fixture: DecisionFixture): Promise<DecisionFixture> {
  await useBuilder(sql, fixture.builderId);
  const expiresAt = await sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);
    await tx`ALTER TABLE budget_accounts DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservations DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservation_allocations DISABLE TRIGGER USER`;

    const [reservation] = await tx<{ expires_at: Date; reserved_at: Date }[]>`
      WITH times AS (
        SELECT date_trunc(
                 'milliseconds',
                 clock_timestamp() + INTERVAL '1.5 seconds'
               ) AS expires_at
      )
      UPDATE budget_reservations reservation
      SET created_at = times.expires_at - INTERVAL '300 seconds',
          updated_at = times.expires_at - INTERVAL '300 seconds',
          reserved_at = times.expires_at - INTERVAL '300 seconds',
          expires_at = times.expires_at,
          reserve_response_snapshot = jsonb_set(
            reserve_response_snapshot,
            '{expires_at}',
            to_jsonb(public.pylva_budget_timestamp_text(times.expires_at))
          )
      FROM times
      WHERE reservation.builder_id = ${fixture.builderId}
        AND reservation.decision_id = ${fixture.decisionId}
      RETURNING reservation.expires_at, reservation.reserved_at
    `;
    await tx`
      WITH parent_period AS (
        SELECT date_trunc('day', reservation.created_at AT TIME ZONE 'UTC')
                 AT TIME ZONE 'UTC' AS period_start
        FROM budget_reservations reservation
        WHERE reservation.builder_id = ${fixture.builderId}
          AND reservation.decision_id = ${fixture.decisionId}
      ), patched AS (
        SELECT account.id, parent_period.period_start,
               parent_period.period_start + INTERVAL '1 day' AS period_end,
               jsonb_set(
                 jsonb_set(
                   account.initial_rule_snapshot,
                   '{period_start}',
                   to_jsonb(public.pylva_budget_timestamp_text(parent_period.period_start))
                 ),
                 '{period_end}',
                 to_jsonb(public.pylva_budget_timestamp_text(
                   parent_period.period_start + INTERVAL '1 day'
                 ))
               ) AS rule_snapshot
        FROM budget_accounts account
        CROSS JOIN parent_period
        WHERE account.builder_id = ${fixture.builderId}
          AND account.id = ${fixture.account.accountId}
      )
      UPDATE budget_accounts account
      SET period_start = patched.period_start, period_end = patched.period_end,
          initial_rule_snapshot = patched.rule_snapshot,
          initial_rule_snapshot_hash =
            public.pylva_budget_jsonb_sha256(patched.rule_snapshot)
      FROM patched
      WHERE account.builder_id = ${fixture.builderId} AND account.id = patched.id
    `;
    await tx`
      UPDATE budget_reservation_allocations allocation
      SET rule_snapshot = account.initial_rule_snapshot,
          rule_snapshot_hash = account.initial_rule_snapshot_hash,
          created_at = reservation.created_at,
          updated_at = reservation.created_at
      FROM budget_accounts account, budget_reservations reservation
      WHERE allocation.builder_id = ${fixture.builderId}
        AND allocation.reservation_decision_id = ${fixture.decisionId}
        AND account.builder_id = allocation.builder_id
        AND account.id = allocation.account_id
        AND reservation.builder_id = allocation.builder_id
        AND reservation.decision_id = allocation.reservation_decision_id
    `;

    await tx`ALTER TABLE budget_reservation_allocations ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservations ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_accounts ENABLE TRIGGER USER`;
    await tx`
      SELECT public.pylva_budget_assert_reservation_snapshots(
        ${fixture.builderId}, ${fixture.decisionId}
      )
    `;
    await tx`
      SELECT public.pylva_budget_assert_reservation_allocations(
        ${fixture.builderId}, ${fixture.decisionId}, FALSE
      )
    `;
    await tx`
      SELECT public.pylva_budget_assert_account_postings(
        ${fixture.builderId}, ${fixture.account.accountId}
      )
    `;
    return {
      expiresAt: reservation!.expires_at.toISOString(),
      reservedAt: reservation!.reserved_at.toISOString(),
    };
  });
  const account = await loadAccount(sql, fixture.builderId, fixture.account.accountId);
  return { ...fixture, account, expiresAt: expiresAt.expiresAt, reservedAt: expiresAt.reservedAt };
}

async function backdateCommittedForRetention(sql: Db, fixture: DecisionFixture): Promise<void> {
  if (!fixture.usageId || !fixture.outboxId) {
    throw new Error('retention fixture requires committed usage and outbox rows');
  }
  const outboxId = fixture.outboxId;
  const usageId = fixture.usageId;
  const pastExpiresAt = addSeconds(PAST_RESERVED_AT, 300);
  const retainUntil = addDays(PAST_COMMITTED_AT, 365);
  await useBuilder(sql, fixture.builderId);
  await sql.begin(async (tx) => {
    await useBuilder(tx, fixture.builderId);

    // Retention tests need old immutable evidence. The scratch database owner
    // constructs it directly; ordinary application roles remain guard-bound.
    await tx`ALTER TABLE budget_reservations DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservation_allocations DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservation_transitions DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_usage_ledger DISABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_cost_event_outbox DISABLE TRIGGER USER`;

    await tx`
      UPDATE budget_reservations
      SET created_at = ${PAST_RESERVED_AT}, reserved_at = ${PAST_RESERVED_AT},
          expires_at = ${pastExpiresAt}, committed_at = ${PAST_COMMITTED_AT},
          updated_at = ${PAST_COMMITTED_AT},
          reserve_response_snapshot = jsonb_set(
            reserve_response_snapshot,
            '{expires_at}',
            to_jsonb(${pastExpiresAt}::text)
          )
      WHERE builder_id = ${fixture.builderId} AND decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_allocations
      SET created_at = ${PAST_RESERVED_AT}, updated_at = ${PAST_COMMITTED_AT}
      WHERE builder_id = ${fixture.builderId}
        AND reservation_decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_reservation_transitions
      SET from_expires_at = ${pastExpiresAt}, to_expires_at = ${pastExpiresAt},
          occurred_at = ${PAST_COMMITTED_AT},
          response_snapshot = jsonb_set(
            response_snapshot,
            '{committed_at}',
            to_jsonb(${PAST_COMMITTED_AT}::text)
          )
      WHERE builder_id = ${fixture.builderId}
        AND reservation_decision_id = ${fixture.decisionId}
    `;
    await tx`
      UPDATE budget_usage_ledger
      SET committed_at = ${PAST_COMMITTED_AT}, created_at = ${PAST_COMMITTED_AT},
          retain_until = ${retainUntil}
      WHERE builder_id = ${fixture.builderId} AND id = ${usageId}
    `;
    await tx`
      WITH projection AS (
        SELECT public.pylva_budget_cost_event_payload(usage) AS payload
        FROM budget_usage_ledger usage
        WHERE usage.builder_id = ${fixture.builderId} AND usage.id = ${usageId}
      )
      UPDATE budget_cost_event_outbox outbox
      SET payload = projection.payload,
          payload_hash = public.pylva_budget_jsonb_sha256(projection.payload)
      FROM projection
      WHERE outbox.builder_id = ${fixture.builderId} AND outbox.id = ${outboxId}
    `;

    await tx`ALTER TABLE budget_cost_event_outbox ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_usage_ledger ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservation_transitions ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservation_allocations ENABLE TRIGGER USER`;
    await tx`ALTER TABLE budget_reservations ENABLE TRIGGER USER`;
  });
}

async function seedPastCommitted(sql: Db, builderId: string): Promise<DecisionFixture> {
  const committed = await commitReservation(sql, await seedDecision(sql, builderId), {
    retentionDays: 90,
    billingRetentionDays: 365,
  });
  await backdateCommittedForRetention(sql, committed);
  return committed;
}

describe('migration 050 physical authority contract', () => {
  it('applies cleanly and creates exactly the seven authoritative ledger tables', async () => {
    const rows = await db()<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${LEDGER_TABLES as unknown as string[]})
      ORDER BY table_name
    `;
    expect(rows.map((row) => row.table_name)).toEqual([...LEDGER_TABLES].sort());
  });

  it('repeats without replacing tables or duplicating policies and triggers', async () => {
    const before = await db()<{ oid: string; table_name: string }[]>`
      SELECT c.relname AS table_name, c.oid::text AS oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY(${LEDGER_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
    const migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');
    await db().begin((tx) => tx.unsafe(migrationSql));
    const after = await db()<{ oid: string; table_name: string }[]>`
      SELECT c.relname AS table_name, c.oid::text AS oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname = ANY(${LEDGER_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
    expect(after).toEqual(before);

    const policies = await db()<{ count: string; tablename: string }[]>`
      SELECT tablename, COUNT(*)::text AS count
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(${LEDGER_TABLES as unknown as string[]})
      GROUP BY tablename
      ORDER BY tablename
    `;
    expect(policies).toHaveLength(LEDGER_TABLES.length);
    expect(policies.every((row) => row.count === '1')).toBe(true);

    const triggers = await db()<{ trigger_name: string }[]>`
      SELECT trigger_row.tgname AS trigger_name
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY(${LEDGER_TABLES as unknown as string[]})
        AND NOT trigger_row.tgisinternal
      ORDER BY trigger_row.tgname
    `;
    expect(triggers.map((row) => row.trigger_name)).toEqual([...LEDGER_TRIGGERS].sort());
  });

  it('pins the search path of every authoritative budget helper', async () => {
    const unpinned = await db()<{ function_name: string }[]>`
      SELECT function_row.proname AS function_name
      FROM pg_proc function_row
      JOIN pg_namespace namespace ON namespace.oid = function_row.pronamespace
      WHERE namespace.nspname = 'public'
        AND function_row.proname LIKE 'pylva_budget_%'
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(
            COALESCE(function_row.proconfig, ARRAY[]::text[])
          ) AS setting(value)
          WHERE setting.value LIKE 'search_path=%'
        )
      ORDER BY function_row.proname
    `;
    expect(unpinned).toEqual([]);
  });

  it('uses exact wire numerics, an unbounded committed accumulator, forced RLS, and tenant-composite foreign keys', async () => {
    const numerics = await db()<
      {
        column_name: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
        table_name: string;
      }[]
    >`
      SELECT table_name, column_name, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY(${LEDGER_TABLES as unknown as string[]})
        AND data_type = 'numeric'
    `;
    expect(numerics.length).toBeGreaterThan(20);
    const committedAccumulator = numerics.find(
      (row) => row.table_name === 'budget_accounts' && row.column_name === 'committed_usd',
    );
    expect(committedAccumulator).toMatchObject({ numeric_precision: null, numeric_scale: null });
    expect(
      numerics
        .filter((row) => row !== committedAccumulator)
        .every((row) => row.numeric_precision === 38 && row.numeric_scale === 18),
    ).toBe(true);

    const rls = await db()<{ relforcerowsecurity: boolean; relrowsecurity: boolean }[]>`
      SELECT c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY(${LEDGER_TABLES as unknown as string[]})
      ORDER BY c.relname
    `;
    expect(rls).toHaveLength(LEDGER_TABLES.length);
    expect(rls.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);

    const foreignKeys = await db()<{ child_columns: string[]; parent_columns: string[] }[]>`
      SELECT
        ARRAY(
          SELECT a.attname
          FROM unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum, ordinality)
          JOIN pg_attribute a
            ON a.attrelid = constraint_row.conrelid AND a.attnum = key_column.attnum
          ORDER BY key_column.ordinality
        ) AS child_columns,
        ARRAY(
          SELECT a.attname
          FROM unnest(constraint_row.confkey) WITH ORDINALITY key_column(attnum, ordinality)
          JOIN pg_attribute a
            ON a.attrelid = constraint_row.confrelid AND a.attnum = key_column.attnum
          ORDER BY key_column.ordinality
        ) AS parent_columns
      FROM pg_constraint constraint_row
      JOIN pg_class child ON child.oid = constraint_row.conrelid
      JOIN pg_class parent ON parent.oid = constraint_row.confrelid
      JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
      WHERE constraint_row.contype = 'f'
        AND namespace.nspname = 'public'
        AND child.relname = ANY(${LEDGER_TABLES as unknown as string[]})
        AND parent.relname = ANY(${LEDGER_TABLES as unknown as string[]})
    `;
    expect(foreignKeys.length).toBeGreaterThanOrEqual(7);
    for (const foreignKey of foreignKeys) {
      expect(foreignKey.child_columns).toContain('builder_id');
      expect(foreignKey.parent_columns).toContain('builder_id');
      expect(foreignKey.child_columns).toHaveLength(foreignKey.parent_columns.length);
    }
  });
});

describe('global rule revision lifecycle and provenance', () => {
  it.each([
    ['pooled, untargeted', 'pooled', null, null, 'customer_2'],
    ['per-customer, untargeted', 'per_customer', null, 'customer_2', 'customer_2'],
    ['per-customer, targeted', 'per_customer', 'customer_1', 'customer_1', 'customer_1'],
  ] as const)(
    'applies a %s global revision to its matching customer bucket',
    async (_case, scope, targetCustomerId, subjectCustomerId, customerId) => {
      const builderId = await insertBuilder(db(), `ledger-applicability-${scope}`);
      const account = await insertAccount(db(), builderId, {
        scope,
        subjectCustomerId,
        targetCustomerId,
      });
      const matching = await seedDecision(db(), builderId, { account, customerId });
      expect(matching.ruleRevisionIds).toEqual([account.ruleRevisionId]);

      if (targetCustomerId !== null) {
        const excluded = await seedDecision(db(), builderId, {
          account,
          customerId: 'customer_2',
          kind: 'no_applicable',
        });
        expect(excluded.ruleRevisionIds).toEqual([]);
      }
    },
  );

  it('rejects customer targeting on a pooled global revision', async () => {
    const builderId = await insertBuilder(db(), 'ledger-pooled-target');
    await expect(
      insertAccount(db(), builderId, {
        scope: 'pooled',
        targetCustomerId: 'customer_1',
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/budget_rule_revisions_target_ck|pooled rules cannot target/i),
    });
  });

  it('materializes revision zero before its first stable account and preserves both provenance layers', async () => {
    const builderId = await insertBuilder(db(), 'ledger-global-revision-zero');
    const account = await insertAccount(db(), builderId, {
      enforcement: 'advisory',
      limitUsd: '12.5',
    });
    const revision = await loadRuleRevision(db(), builderId, account.ruleRevisionId!);
    const [stored] = await db()<
      {
        initial_rule_revision_id: string;
        initial_rule_snapshot: JsonObject;
        initial_rule_snapshot_hash: string;
        version: string;
      }[]
    >`
      SELECT initial_rule_revision_id, initial_rule_snapshot,
             initial_rule_snapshot_hash, version::text
      FROM budget_accounts
      WHERE builder_id = ${builderId} AND id = ${account.accountId}
    `;

    expect(revision).toMatchObject({
      enforcement: 'advisory',
      limitUsd: '12.5',
      period: 'day',
      revision: 0,
      ruleKey: account.ruleKey,
      scope: 'pooled',
      targetCustomerId: null,
    });
    expect(revision.configSnapshot).toEqual({
      schema_version: '1.0',
      rule_key: account.ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'advisory',
      limit_usd: '12.5',
    });
    expect(stored).toMatchObject({
      initial_rule_revision_id: revision.ruleRevisionId,
      initial_rule_snapshot: account.ruleSnapshot,
      initial_rule_snapshot_hash: account.ruleSnapshotHash,
      version: '0',
    });
  });

  it('rotates limit and enforcement once while retaining the stable account row and counters', async () => {
    const builderId = await insertBuilder(db(), 'ledger-global-rotation');
    const account = await insertAccount(db(), builderId);
    await commitReservation(db(), await seedDecision(db(), builderId, { account }), {
      actualUsd: '2',
    });
    const [beforeAccount] = await db()<{ value: JsonObject }[]>`
      SELECT to_jsonb(account) AS value
      FROM budget_accounts account
      WHERE builder_id = ${builderId} AND id = ${account.accountId}
    `;

    const { retired, successor } = await rotateRuleRevision(db(), builderId, account.ruleKey, {
      enforcement: 'advisory',
      limitUsd: '25',
    });
    const [afterAccount] = await db()<{ value: JsonObject }[]>`
      SELECT to_jsonb(account) AS value
      FROM budget_accounts account
      WHERE builder_id = ${builderId} AND id = ${account.accountId}
    `;
    const refreshed = await loadAccount(db(), builderId, account.accountId);
    const nextDecision = await seedDecision(db(), builderId, { account: refreshed });
    const [evidence] = await db()<
      {
        allocation_revision_id: string;
        enforcement: string;
        limit_usd: string;
        response_contains_revision_ids: boolean;
      }[]
    >`
      SELECT allocation.rule_revision_id AS allocation_revision_id,
             allocation.enforcement, allocation.limit_usd::text,
             reservation.reserve_response_snapshot ? 'rule_revision_ids'
               AS response_contains_revision_ids
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${nextDecision.decisionId}
    `;

    expect(afterAccount!.value).toEqual(beforeAccount!.value);
    expect(retired).toMatchObject({
      retirementReason: 'superseded',
      revision: 0,
    });
    expect(successor).toMatchObject({
      activeFrom: retired.retiredAt,
      enforcement: 'advisory',
      limitUsd: '25',
      revision: 1,
      ruleKey: account.ruleKey,
    });
    expect(refreshed).toMatchObject({
      committedUsd: '2.000000000000000000',
      enforcement: 'advisory',
      limitUsd: '25',
      ruleRevision: 1,
      ruleRevisionId: successor.ruleRevisionId,
    });
    expect(evidence).toEqual({
      allocation_revision_id: successor.ruleRevisionId,
      enforcement: 'advisory',
      limit_usd: '25.000000000000000000',
      response_contains_revision_ids: false,
    });
  });

  it('moves two per-customer accumulators to one successor atomically without resetting either', async () => {
    const builderId = await insertBuilder(db(), 'ledger-global-customer-rotation');
    const ruleKey = crypto.randomUUID();
    const customerOne = await insertAccount(db(), builderId, {
      ruleKey,
      scope: 'per_customer',
      subjectCustomerId: 'customer_1',
    });
    const customerTwo = await insertAccount(db(), builderId, {
      ruleKey,
      scope: 'per_customer',
      subjectCustomerId: 'customer_2',
    });
    await seedDecision(db(), builderId, {
      account: customerOne,
      customerId: 'customer_1',
      requestedUsd: '1',
    });
    await seedDecision(db(), builderId, {
      account: customerTwo,
      customerId: 'customer_2',
      requestedUsd: '2',
    });

    const { successor } = await rotateRuleRevision(db(), builderId, ruleKey, {
      enforcement: 'advisory',
      limitUsd: '40',
    });
    const refreshedOne = await loadAccount(db(), builderId, customerOne.accountId);
    const refreshedTwo = await loadAccount(db(), builderId, customerTwo.accountId);
    const afterOne = await seedDecision(db(), builderId, {
      account: refreshedOne,
      customerId: 'customer_1',
    });
    const afterTwo = await seedDecision(db(), builderId, {
      account: refreshedTwo,
      customerId: 'customer_2',
    });
    const rows = await db()<
      { account_id: string; reserved_usd: string; rule_revision_id: string }[]
    >`
      SELECT account.id AS account_id, account.reserved_usd::text,
             allocation.rule_revision_id
      FROM budget_reservation_allocations allocation
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id IN (${afterOne.decisionId}, ${afterTwo.decisionId})
      ORDER BY account.id
    `;

    expect(customerOne.ruleRevisionId).toBe(customerTwo.ruleRevisionId);
    expect(refreshedOne).toMatchObject({
      enforcement: 'advisory',
      reservedUsd: '1.000000000000000000',
      ruleRevisionId: successor.ruleRevisionId,
    });
    expect(refreshedTwo).toMatchObject({
      enforcement: 'advisory',
      reservedUsd: '2.000000000000000000',
      ruleRevisionId: successor.ruleRevisionId,
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.rule_revision_id === successor.ruleRevisionId)).toBe(true);
    expect(new Set(rows.map((row) => row.account_id))).toEqual(
      new Set([customerOne.accountId, customerTwo.accountId]),
    );
  });

  it('rejects revision mutation, deletion, and a null retirement without retiring the active row', async () => {
    const builderId = await insertBuilder(db(), 'ledger-revision-immutable');
    const account = await insertAccount(db(), builderId);
    await useBuilder(db(), builderId);

    await expect(
      db()`
        UPDATE budget_rule_revisions SET limit_usd = 11
        WHERE builder_id = ${builderId} AND id = ${account.ruleRevisionId!}
      `,
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      db()`
        UPDATE budget_rule_revisions SET retirement_reason = NULL
        WHERE builder_id = ${builderId} AND id = ${account.ruleRevisionId!}
      `,
    ).rejects.toMatchObject({
      code: '55000',
      message: expect.stringMatching(/only one server-timed retirement/i),
    });
    await expect(
      db()`
        DELETE FROM budget_rule_revisions
        WHERE builder_id = ${builderId} AND id = ${account.ruleRevisionId!}
      `,
    ).rejects.toMatchObject({ code: '55000' });

    const stillActive = await loadRuleRevision(db(), builderId, account.ruleRevisionId!);
    expect(stillActive).toMatchObject({ retiredAt: null, retirementReason: null, revision: 0 });
  });

  it('requires an immediate successor for superseded revisions and rejects a successor while active', async () => {
    const builderId = await insertBuilder(db(), 'ledger-revision-successor');
    const account = await insertAccount(db(), builderId);
    const revision = await loadRuleRevision(db(), builderId, account.ruleRevisionId!);
    await useBuilder(db(), builderId);

    await expect(insertRuleRevision(db(), builderId, revision, { limitUsd: '11' })).rejects.toThrow(
      /active rule revision must be retired before replacement/i,
    );
    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await retireRuleRevision(tx, builderId, revision.ruleRevisionId, 'superseded');
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/requires its immediate successor in the same transaction/i),
    });
    expect(await loadLatestRuleRevision(db(), builderId, account.ruleKey)).toMatchObject({
      retiredAt: null,
      revision: 0,
    });
  });

  it.each([
    ['scope', { scope: 'per_customer' as const }],
    ['customer target', { targetCustomerId: 'customer_1' }],
    ['period', { period: 'hour' as const }],
  ])('rejects a structural %s change across revisions', async (_field, overrides) => {
    const builderId = await insertBuilder(db(), `ledger-rev-${_field.replaceAll(' ', '-')}`);
    const account = await insertAccount(db(), builderId);
    const revision = await loadRuleRevision(db(), builderId, account.ruleRevisionId!);

    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await retireRuleRevision(tx, builderId, revision.ruleRevisionId, 'superseded');
        await insertRuleRevision(tx, builderId, revision, overrides);
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/scope, customer targeting, and period are immutable/i),
    });
    expect(await loadLatestRuleRevision(db(), builderId, account.ruleKey)).toMatchObject({
      retiredAt: null,
      revision: 0,
    });
  });

  it('allows disabled rules to resume accumulated spend but makes deleted rules terminal', async () => {
    const builderId = await insertBuilder(db(), 'ledger-disable-reenable-delete');
    const account = await insertAccount(db(), builderId);
    await commitReservation(db(), await seedDecision(db(), builderId, { account }), {
      actualUsd: '2',
    });
    const revisionZero = await loadRuleRevision(db(), builderId, account.ruleRevisionId!);
    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await retireRuleRevision(tx, builderId, revisionZero.ruleRevisionId, 'disabled');
    });

    const disabledDecision = await seedDecision(db(), builderId, {
      account,
      kind: 'no_applicable',
    });
    expect(disabledDecision.ruleRevisionIds).toEqual([]);

    const revisionOne = await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      return insertRuleRevision(tx, builderId, revisionZero, { limitUsd: '20' });
    });
    const resumedAccount = await loadAccount(db(), builderId, account.accountId);
    expect(resumedAccount).toMatchObject({
      committedUsd: '2.000000000000000000',
      limitUsd: '20',
      ruleRevision: 1,
      ruleRevisionId: revisionOne.ruleRevisionId,
    });
    await expect(seedDecision(db(), builderId, { account: resumedAccount })).resolves.toMatchObject(
      {
        ruleRevisionIds: [revisionOne.ruleRevisionId],
      },
    );

    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await retireRuleRevision(tx, builderId, revisionOne.ruleRevisionId, 'deleted');
    });
    const deletedDecision = await seedDecision(db(), builderId, {
      account,
      kind: 'no_applicable',
    });
    expect(deletedDecision.ruleRevisionIds).toEqual([]);
    await useBuilder(db(), builderId);
    await expect(insertRuleRevision(db(), builderId, revisionOne)).rejects.toThrow(
      /deleted budget rule cannot be reactivated/i,
    );
  });

  it('settles a held reservation against its frozen revision after that revision is disabled', async () => {
    const builderId = await insertBuilder(db(), 'ledger-retired-revision-settlement');
    const held = await seedDecision(db(), builderId);
    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await retireRuleRevision(tx, builderId, held.account.ruleRevisionId!, 'disabled');
    });

    const committed = await commitReservation(db(), held, { actualUsd: '1' });
    const [row] = await db()<
      { allocation_revision_id: string; retirement_reason: string; status: string }[]
    >`
      SELECT allocation.rule_revision_id AS allocation_revision_id,
             revision.retirement_reason, allocation.status
      FROM budget_reservation_allocations allocation
      JOIN budget_rule_revisions revision
        ON revision.builder_id = allocation.builder_id
       AND revision.id = allocation.rule_revision_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      allocation_revision_id: held.account.ruleRevisionId,
      retirement_reason: 'disabled',
      status: 'committed',
    });
  });

  it('settles a held reservation against its frozen revision after that revision is deleted', async () => {
    const builderId = await insertBuilder(db(), 'ledger-deleted-revision-settlement');
    const held = await seedDecision(db(), builderId);
    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await retireRuleRevision(tx, builderId, held.account.ruleRevisionId!, 'deleted');
    });

    const committed = await commitReservation(db(), held, { actualUsd: '1' });
    const [row] = await db()<
      { allocation_revision_id: string; retirement_reason: string; status: string }[]
    >`
      SELECT allocation.rule_revision_id AS allocation_revision_id,
             revision.retirement_reason, allocation.status
      FROM budget_reservation_allocations allocation
      JOIN budget_rule_revisions revision
        ON revision.builder_id = allocation.builder_id
       AND revision.id = allocation.rule_revision_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      allocation_revision_id: held.account.ruleRevisionId,
      retirement_reason: 'deleted',
      status: 'committed',
    });
  });

  it('server-owns the canonical reservation revision set and rejects revision substitution', async () => {
    const builderId = await insertBuilder(db(), 'ledger-server-rule-set');
    const account = await insertAccount(db(), builderId);
    const injectedIds = [crypto.randomUUID(), crypto.randomUUID()].sort().reverse();
    const decision = await seedDecision(db(), builderId, {
      account,
      ruleRevisionIdsOverride: injectedIds,
      ruleSetHashOverride: 'f'.repeat(64),
    });
    expect(decision.ruleRevisionIds).toEqual([account.ruleRevisionId]);
    expect(decision.ruleSetHash).not.toBe('f'.repeat(64));
    await useBuilder(db(), builderId);
    await expect(
      db()`
        UPDATE budget_reservations
        SET rule_revision_ids = ARRAY[]::uuid[]
        WHERE builder_id = ${builderId} AND decision_id = ${decision.decisionId}
      `,
    ).rejects.toMatchObject({ code: '55000' });

    await releaseReservation(db(), decision);
    const { successor } = await rotateRuleRevision(db(), builderId, account.ruleKey, {
      limitUsd: '11',
    });
    const refreshed = await loadAccount(db(), builderId, account.accountId);
    await expect(
      seedDecision(db(), builderId, {
        account: refreshed,
        allocationRuleRevisionId: account.ruleRevisionId!,
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(
        /allocation rule revision was not in the reservation rule set/i,
      ),
    });
    expect(successor.ruleRevisionId).not.toBe(account.ruleRevisionId);
  });

  it('rejects configuration changes after a reservation even after deferred checks are flushed', async () => {
    const builderId = await insertBuilder(db(), 'ledger-same-transaction-config');
    const account = await insertAccount(db(), builderId);

    await expect(
      seedDecision(db(), builderId, {
        account,
        beforeCommit: async (tx) => {
          await tx`SET CONSTRAINTS ALL IMMEDIATE`;
          await tx`
            UPDATE budget_rule_revisions
            SET retirement_reason = 'disabled'
            WHERE builder_id = ${builderId} AND id = ${account.ruleRevisionId!}
          `;
        },
      }),
    ).rejects.toMatchObject({
      code: '25001',
      message: expect.stringMatching(/configuration cannot change after a reservation/i),
    });
    expect(await loadLatestRuleRevision(db(), builderId, account.ruleKey)).toMatchObject({
      retiredAt: null,
    });
  });

  it('rejects account materialization after a reservation in the same transaction', async () => {
    const builderId = await insertBuilder(db(), 'ledger-account-after-reservation');
    const account = await insertAccount(db(), builderId);
    await expect(
      seedDecision(db(), builderId, {
        account,
        beforeCommit: async (tx) => {
          await tx`
            INSERT INTO budget_accounts (
              builder_id, id, rule_key, enforcement, limit_usd, scope,
              subject_customer_id, period, period_start, period_end,
              initial_rule_revision_id, initial_rule_snapshot, initial_rule_snapshot_hash,
              opening_committed_usd, committed_usd
            )
            VALUES (
              ${builderId}, ${crypto.randomUUID()}, ${account.ruleKey}, 'hard_stop', 10,
              'pooled', NULL, 'day', ${account.periodEnd}, ${addDays(account.periodEnd, 1)},
              ${account.ruleRevisionId!}, ${tx.json({})}, ${'0'.repeat(64)}, 0, 0
            )
          `;
        },
      }),
    ).rejects.toMatchObject({
      code: '25001',
      message: expect.stringMatching(/materialized before reservations in the same transaction/i),
    });
  });

  it('allows an atomic configuration cutover before observation and captures only the successor', async () => {
    const builderId = await insertBuilder(db(), 'ledger-config-before-reservation');
    const account = await insertAccount(db(), builderId);
    let successorId: string | undefined;
    const decision = await seedDecision(db(), builderId, {
      account,
      beforeObservation: async (tx) => {
        const current = await loadLatestRuleRevision(tx, builderId, account.ruleKey);
        await retireRuleRevision(tx, builderId, current.ruleRevisionId, 'superseded');
        const successor = await insertRuleRevision(tx, builderId, current, {
          enforcement: 'advisory',
          limitUsd: '15',
        });
        successorId = successor.ruleRevisionId;
      },
    });

    expect(successorId).toBeDefined();
    expect(decision.ruleRevisionIds).toEqual([successorId]);
    const [allocation] = await db()<
      { enforcement: string; limit_usd: string; rule_revision_id: string }[]
    >`
      SELECT rule_revision_id, enforcement, limit_usd::text
      FROM budget_reservation_allocations
      WHERE builder_id = ${builderId}
        AND reservation_decision_id = ${decision.decisionId}
    `;
    expect(allocation).toEqual({
      enforcement: 'advisory',
      limit_usd: '15.000000000000000000',
      rule_revision_id: successorId,
    });
  });
});

describe('reserve, deny, and shadow decision closure', () => {
  it('posts a serialized hold from typed account state and preserves canonical snapshots', async () => {
    const builderId = await insertBuilder(db(), 'ledger-reserve');
    const fixture = await seedDecision(db(), builderId);
    const [row] = await db()<
      {
        account_reserved: string;
        account_version: string;
        account_version_before: string;
        allocation_status: string;
        held_at_reserve: boolean;
        request_hash_matches: boolean;
        response_decision: string;
      }[]
    >`
      SELECT account.reserved_usd::text AS account_reserved,
             account.version::text AS account_version,
             allocation.account_version_before::text,
             allocation.status AS allocation_status,
             allocation.held_at_reserve,
             reservation.request_hash =
               public.pylva_budget_jsonb_sha256(reservation.request_snapshot)
               AS request_hash_matches,
             reservation.reserve_response_snapshot->>'decision' AS response_decision
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${fixture.decisionId}
    `;
    expect(row).toEqual({
      account_reserved: '1.000000000000000000',
      account_version: '1',
      account_version_before: '0',
      allocation_status: 'reserved',
      held_at_reserve: true,
      request_hash_matches: true,
      response_decision: 'reserved',
    });
  });

  it.each([
    ['denied', 'refused', true, '0.000000000000000000'],
    ['shadow_allow', 'shadow', false, '0.000000000000000000'],
    ['shadow_deny', 'shadow', true, '0.000000000000000000'],
  ] as const)(
    'closes a %s decision with the exact evaluation record and no hold',
    async (kind, expectedStatus, expectedDeciding, expectedReserved) => {
      const builderId = await insertBuilder(db(), `ledger-${kind}`);
      const fixture = await seedDecision(db(), builderId, { kind });
      const [row] = await db()<
        {
          account_reserved: string;
          allocation_status: string;
          decision: string;
          is_deciding: boolean;
        }[]
      >`
        SELECT reservation.decision, allocation.status AS allocation_status,
               allocation.is_deciding, account.reserved_usd::text AS account_reserved
        FROM budget_reservations reservation
        JOIN budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        WHERE reservation.builder_id = ${builderId}
          AND reservation.decision_id = ${fixture.decisionId}
      `;
      expect(row).toMatchObject({
        account_reserved: expectedReserved,
        allocation_status: expectedStatus,
        is_deciding: expectedDeciding,
      });
      expect(row!.decision).toBe(kind === 'denied' ? 'denied' : 'bypassed');
    },
  );

  it('rejects a reserved decision that omits its allocation closure', async () => {
    const builderId = await insertBuilder(db(), 'ledger-missing-allocation');
    await expect(seedDecision(db(), builderId, { omitAllocation: true })).rejects.toThrow(
      /reserved lifecycle requires matching allocation settlement/i,
    );
  });

  it('persists an unavailable decision with a null public decision id and no allocation', async () => {
    const builderId = await insertBuilder(db(), 'ledger-unavailable');
    const fixture = await seedDecision(db(), builderId, { kind: 'unavailable' });
    const [row] = await db()<{ allocation_count: string; decision_id: unknown; reason: string }[]>`
      SELECT COUNT(allocation.id)::text AS allocation_count,
             reservation.reserve_response_snapshot->'decision_id' AS decision_id,
             reservation.reserve_response_snapshot->>'reason' AS reason
      FROM budget_reservations reservation
      LEFT JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${fixture.decisionId}
      GROUP BY reservation.reserve_response_snapshot
    `;
    expect(row).toEqual({
      allocation_count: '0',
      decision_id: null,
      reason: 'control_unavailable',
    });

    const matchingBuilder = await insertBuilder(db(), 'ledger-unavailable-matching-id');
    const matching = await seedDecision(db(), matchingBuilder, {
      kind: 'unavailable',
      unavailableDecisionId: 'matching',
    });
    const [matchingRow] = await db()<{ decision_id: string }[]>`
      SELECT reserve_response_snapshot->>'decision_id' AS decision_id
      FROM budget_reservations
      WHERE builder_id = ${matchingBuilder} AND decision_id = ${matching.decisionId}
    `;
    expect(matchingRow!.decision_id).toBe(matching.decisionId);
  });

  it('serializes sequential zero-dollar holds without inventing spend', async () => {
    const builderId = await insertBuilder(db(), 'ledger-zero-holds');
    const account = await insertAccount(db(), builderId);
    await seedDecision(db(), builderId, { account, requestedUsd: '0' });
    await seedDecision(db(), builderId, { account, requestedUsd: '0' });
    const [row] = await db()<{ allocation_count: string; reserved_usd: string; version: string }[]>`
      SELECT COUNT(allocation.id)::text AS allocation_count,
             account.reserved_usd::text, account.version::text
      FROM budget_accounts account
      LEFT JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = account.builder_id AND allocation.account_id = account.id
      WHERE account.builder_id = ${builderId} AND account.id = ${account.accountId}
      GROUP BY account.builder_id, account.id
    `;
    expect(row).toEqual({
      allocation_count: '2',
      reserved_usd: '0.000000000000000000',
      version: '2',
    });
  });

  it('allows an advisory over-limit reservation and emits its exact warning evidence', async () => {
    const builderId = await insertBuilder(db(), 'ledger-advisory-warning');
    const account = await insertAccount(db(), builderId, {
      enforcement: 'advisory',
      limitUsd: '0',
    });
    const fixture = await seedDecision(db(), builderId, { account });
    const [row] = await db()<
      {
        remaining_usd: string | null;
        reserved_usd: string;
        warning: JsonObject;
      }[]
    >`
      SELECT reservation.remaining_usd::text,
             account.reserved_usd::text,
             reservation.reserve_response_snapshot->'warnings'->0 AS warning
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${fixture.decisionId}
    `;
    expect(row).toEqual({
      remaining_usd: null,
      reserved_usd: '1.000000000000000000',
      warning: {
        code: 'advisory_budget_exceeded',
        rule_id: account.ruleKey,
        limit_usd: '0',
        projected_usd: '1',
      },
    });
  });

  it('records overage without calling it a budget breach while post-commit totals remain under limit', async () => {
    const builderId = await insertBuilder(db(), 'ledger-overage');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId), {
      actualUsd: '2',
    });
    const [row] = await db()<
      {
        account_committed: string;
        actual_usd: string;
        authorized_usd: string;
        budget_exceeded_after_commit: boolean;
        overage_usd: string;
        released_usd: string;
      }[]
    >`
      SELECT allocation.authorized_usd::text, allocation.actual_usd::text,
             allocation.released_usd::text, allocation.overage_usd::text,
             account.committed_usd::text AS account_committed,
             (transition.response_snapshot->>'budget_exceeded_after_commit')::boolean
               AS budget_exceeded_after_commit
      FROM budget_reservation_allocations allocation
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = allocation.builder_id
       AND transition.reservation_decision_id = allocation.reservation_decision_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      account_committed: '2.000000000000000000',
      actual_usd: '2.000000000000000000',
      authorized_usd: '1.000000000000000000',
      budget_exceeded_after_commit: false,
      overage_usd: '1.000000000000000000',
      released_usd: '0.000000000000000000',
    });
  });

  it('marks a true hard-stop post-commit total breach independently from overage', async () => {
    const builderId = await insertBuilder(db(), 'ledger-post-commit-breach');
    const account = await insertAccount(db(), builderId, { limitUsd: '1' });
    const committed = await commitReservation(
      db(),
      await seedDecision(db(), builderId, { account }),
      { actualUsd: '2' },
    );
    const [row] = await db()<{ budget_exceeded_after_commit: boolean; overage_usd: string }[]>`
      SELECT allocation.overage_usd::text,
             (transition.response_snapshot->>'budget_exceeded_after_commit')::boolean
               AS budget_exceeded_after_commit
      FROM budget_reservation_allocations allocation
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = allocation.builder_id
       AND transition.reservation_decision_id = allocation.reservation_decision_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      budget_exceeded_after_commit: true,
      overage_usd: '1.000000000000000000',
    });
  });

  it('avoids a frozen-baseline false positive after another hold is released', async () => {
    const builderId = await insertBuilder(db(), 'ledger-live-breach-false-positive');
    const account = await insertAccount(db(), builderId, { limitUsd: '10' });
    const releasedFirst = await seedDecision(db(), builderId, {
      account,
      requestedUsd: '8',
    });
    const committedLater = await seedDecision(db(), builderId, {
      account,
      requestedUsd: '2',
    });
    await releaseReservation(db(), releasedFirst);
    const committed = await commitReservation(db(), committedLater, { actualUsd: '3' });
    const [row] = await db()<
      { frozen_baseline_result: boolean; live_result: boolean; live_total: string }[]
    >`
      SELECT allocation.enforcement = 'hard_stop'
               AND allocation.committed_before_usd
                 + allocation.reserved_before_usd
                 + allocation.unresolved_before_usd
                 + allocation.actual_usd > allocation.limit_usd
               AS frozen_baseline_result,
             (transition.response_snapshot->>'budget_exceeded_after_commit')::boolean
               AS live_result,
             (account.committed_usd + account.reserved_usd + account.unresolved_usd)::text
               AS live_total
      FROM budget_reservation_allocations allocation
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = allocation.builder_id
       AND transition.reservation_decision_id = allocation.reservation_decision_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      frozen_baseline_result: true,
      live_result: false,
      live_total: '3.000000000000000000',
    });
  });

  it('avoids a frozen-baseline false negative after an interleaved commit increases live spend', async () => {
    const builderId = await insertBuilder(db(), 'ledger-live-breach-false-negative');
    const account = await insertAccount(db(), builderId, { limitUsd: '10' });
    const committedLast = await seedDecision(db(), builderId, {
      account,
      requestedUsd: '2',
    });
    const committedFirst = await seedDecision(db(), builderId, {
      account,
      requestedUsd: '7',
    });
    await commitReservation(db(), committedFirst, { actualUsd: '9' });
    const committed = await commitReservation(db(), committedLast, { actualUsd: '2' });
    const [row] = await db()<
      { frozen_baseline_result: boolean; live_result: boolean; live_total: string }[]
    >`
      SELECT allocation.enforcement = 'hard_stop'
               AND allocation.committed_before_usd
                 + allocation.reserved_before_usd
                 + allocation.unresolved_before_usd
                 + allocation.actual_usd > allocation.limit_usd
               AS frozen_baseline_result,
             (transition.response_snapshot->>'budget_exceeded_after_commit')::boolean
               AS live_result,
             (account.committed_usd + account.reserved_usd + account.unresolved_usd)::text
               AS live_total
      FROM budget_reservation_allocations allocation
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = allocation.builder_id
       AND transition.reservation_decision_id = allocation.reservation_decision_id
      WHERE allocation.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      frozen_baseline_result: false,
      live_result: true,
      live_total: '11.000000000000000000',
    });
  });

  it('retains a commit that crosses 20 integer digits and fails closed on the next wire-bound reserve', async () => {
    const builderId = await insertBuilder(db(), 'ledger-unbounded-committed');
    const account = await insertAccount(db(), builderId, {
      enforcement: 'advisory',
      limitUsd: '99999999999999999999.999999999999999999',
      openingCommittedUsd: '99999999999999999999.5',
    });
    const committed = await commitReservation(
      db(),
      await seedDecision(db(), builderId, { account, requestedUsd: '0' }),
      { actualUsd: '1' },
    );
    const [row] = await db()<
      { committed_usd: string; overage_usd: string; reserved_usd: string }[]
    >`
      SELECT account.committed_usd::text, account.reserved_usd::text,
             allocation.overage_usd::text
      FROM budget_accounts account
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = account.builder_id AND allocation.account_id = account.id
      WHERE account.builder_id = ${builderId}
        AND allocation.reservation_decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      committed_usd: '100000000000000000000.500000000000000000',
      overage_usd: '1.000000000000000000',
      reserved_usd: '0.000000000000000000',
    });

    await expect(seedDecision(db(), builderId, { account, requestedUsd: '0' })).rejects.toThrow(
      /numeric field overflow/i,
    );
  });

  it('settles zero-dollar reservations without phantom counter versions and records real overage', async () => {
    const commitBuilder = await insertBuilder(db(), 'ledger-zero-commit');
    const zeroCommitted = await commitReservation(
      db(),
      await seedDecision(db(), commitBuilder, { requestedUsd: '0' }),
      { actualUsd: '0' },
    );
    const [committedAccount] = await db()<
      { committed_usd: string; reserved_usd: string; version: string }[]
    >`
      SELECT committed_usd::text, reserved_usd::text, version::text
      FROM budget_accounts
      WHERE builder_id = ${commitBuilder} AND id = ${zeroCommitted.account.accountId}
    `;
    expect(committedAccount).toEqual({
      committed_usd: '0',
      reserved_usd: '0.000000000000000000',
      version: '1',
    });

    const releaseBuilder = await insertBuilder(db(), 'ledger-zero-release');
    const zeroReleased = await seedDecision(db(), releaseBuilder, { requestedUsd: '0' });
    await releaseReservation(db(), zeroReleased);
    const [releasedAccount] = await db()<{ reserved_usd: string; version: string }[]>`
      SELECT reserved_usd::text, version::text
      FROM budget_accounts
      WHERE builder_id = ${releaseBuilder} AND id = ${zeroReleased.account.accountId}
    `;
    expect(releasedAccount).toEqual({
      reserved_usd: '0.000000000000000000',
      version: '1',
    });

    const overageBuilder = await insertBuilder(db(), 'ledger-zero-overage');
    const zeroOverage = await commitReservation(
      db(),
      await seedDecision(db(), overageBuilder, { requestedUsd: '0' }),
      { actualUsd: '0.25' },
    );
    const [overageAccount] = await db()<
      { committed_usd: string; overage_usd: string; version: string }[]
    >`
      SELECT account.committed_usd::text, account.version::text,
             allocation.overage_usd::text
      FROM budget_accounts account
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = account.builder_id AND allocation.account_id = account.id
      WHERE account.builder_id = ${overageBuilder}
        AND allocation.reservation_decision_id = ${zeroOverage.decisionId}
    `;
    expect(overageAccount).toEqual({
      committed_usd: '0.250000000000000000',
      overage_usd: '0.250000000000000000',
      version: '2',
    });
  });

  it('accepts the 18,250-day retention sentinel and rejects a larger value', async () => {
    const acceptedBuilder = await insertBuilder(db(), 'ledger-retention-max', 'scale');
    const accepted = await commitReservation(db(), await seedDecision(db(), acceptedBuilder), {
      retentionDays: 18_250,
      billingRetentionDays: 18_250,
    });
    const [row] = await db()<{ billing_retention_days: number; retention_days: number }[]>`
      SELECT retention_days, billing_retention_days
      FROM budget_usage_ledger
      WHERE builder_id = ${acceptedBuilder} AND id = ${accepted.usageId!}
    `;
    expect(row).toEqual({ retention_days: 18_250, billing_retention_days: 18_250 });

    const rejectedBuilder = await insertBuilder(db(), 'ledger-retention-too-large');
    await expect(
      commitReservation(db(), await seedDecision(db(), rejectedBuilder), {
        retentionDays: 18_251,
        billingRetentionDays: 18_251,
      }),
    ).rejects.toThrow(/budget_usage_ledger_retention_ck/i);
  });

  it('rejects a denial whose declared account is not the deciding allocation', async () => {
    const builderId = await insertBuilder(db(), 'ledger-deny-decider');
    await expect(
      seedDecision(db(), builderId, { kind: 'denied', allocationIsDeciding: false }),
    ).rejects.toThrow(/denied response has no deciding allocation|denial requires exactly one/i);
  });

  it('rejects non-canonical request and response snapshots even when their hashes match', async () => {
    const requestBuilder = await insertBuilder(db(), 'ledger-request-shape');
    await expect(
      seedDecision(db(), requestBuilder, {
        requestSnapshotOverride: { unexpected: true },
      }),
    ).rejects.toThrow(/stored LLM reservation request is not canonical/i);

    const responseBuilder = await insertBuilder(db(), 'ledger-response-shape');
    await expect(
      seedDecision(db(), responseBuilder, {
        reserveResponseOverride: { reserved_usd: '1.00' },
      }),
    ).rejects.toThrow(/stored reserved response is not canonical/i);

    const missingKeyBuilder = await insertBuilder(db(), 'ledger-response-missing-key');
    await expect(
      seedDecision(db(), missingKeyBuilder, {
        reserveResponseOverride: { warnings: undefined },
      }),
    ).rejects.toThrow(/stored reserved response is not canonical/i);

    const wrongTypeBuilder = await insertBuilder(db(), 'ledger-request-wrong-type');
    await expect(
      seedDecision(db(), wrongTypeBuilder, {
        requestSnapshotOverride: { reservation_ttl_seconds: '300' },
      }),
    ).rejects.toThrow(/stored reservation request contradicts typed request fields/i);
  });
});

describe('serialized authorization and identity substitution defenses', () => {
  it.each(['repeatable read', 'serializable'] as const)(
    'rejects reservation decisions under %s isolation',
    async (transactionIsolation) => {
      const builderId = await insertBuilder(db(), `ledger-isolation-${transactionIsolation}`);
      const account = await insertAccount(db(), builderId);
      await expect(
        seedDecision(db(), builderId, { account, transactionIsolation }),
      ).rejects.toMatchObject({
        code: '25001',
        message: expect.stringMatching(/require READ COMMITTED isolation/i),
      });
    },
  );

  it('rejects a stale account version after a prior hold has advanced the accumulator', async () => {
    const builderId = await insertBuilder(db(), 'ledger-stale-version');
    const account = await insertAccount(db(), builderId);
    await seedDecision(db(), builderId, { account });

    await expect(
      seedDecision(db(), builderId, { account, accountVersionBefore: 0 }),
    ).rejects.toThrow(/allocation snapshot does not match its locked budget account/i);

    const [row] = await db()<{ reserved_usd: string; version: string }[]>`
      SELECT reserved_usd::text, version::text
      FROM budget_accounts
      WHERE builder_id = ${builderId} AND id = ${account.accountId}
    `;
    expect(row).toEqual({ reserved_usd: '1.000000000000000000', version: '1' });
  });

  it('serializes concurrent same-account reservations across independent database sessions', async () => {
    if (!scratch) throw new Error('scratch database is unavailable');
    const builderId = await insertBuilder(db(), 'ledger-concurrent-reserve');
    const account = await insertAccount(db(), builderId);
    const clientA = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    const clientB = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    let releaseFirst!: () => void;
    let signalFirstReady!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstReady = new Promise<void>((resolve) => {
      signalFirstReady = resolve;
    });
    let first: Promise<DecisionFixture> | undefined;
    let second: Promise<DecisionFixture> | undefined;

    try {
      first = seedDecision(clientA, builderId, {
        account,
        beforeCommit: async () => {
          signalFirstReady();
          await holdFirst;
        },
      });
      await firstReady;
      second = seedDecision(clientB, builderId, { account });

      const observed = await Promise.race([
        second.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(observed).toBe('blocked');

      releaseFirst();
      await expect(first).resolves.toMatchObject({ builderId });
      await expect(second).rejects.toThrow(
        /allocation snapshot does not match its locked budget account/i,
      );
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second].filter(Boolean) as Promise<DecisionFixture>[]);
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it('shares decision materialization locks but excludes account materialization', async () => {
    if (!scratch) throw new Error('scratch database is unavailable');
    const builderId = await insertBuilder(db(), 'ledger-materialization-lock');
    const account = await insertAccount(db(), builderId);
    const clientA = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    const clientB = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    let releaseFirst!: () => void;
    let signalFirstReady!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstReady = new Promise<void>((resolve) => {
      signalFirstReady = resolve;
    });
    let first: Promise<DecisionFixture> | undefined;
    let materialization: Promise<AccountFixture> | undefined;

    try {
      first = seedDecision(clientA, builderId, {
        account,
        kind: 'unavailable',
        beforeCommit: async () => {
          signalFirstReady();
          await holdFirst;
        },
      });
      await firstReady;

      await expect(
        seedDecision(clientB, builderId, { account, kind: 'unavailable' }),
      ).resolves.toMatchObject({ decision: 'unavailable' });

      const exclusiveAvailable = await clientB.begin(async (tx) => {
        const [row] = await tx<{ acquired: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended(${builderId}::text, 50620260714)
          ) AS acquired
        `;
        return row!.acquired;
      });
      expect(exclusiveAvailable).toBe(false);

      materialization = insertAccount(clientB, builderId);
      const observed = await Promise.race([
        materialization.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(observed).toBe('blocked');

      releaseFirst();
      await expect(first).resolves.toMatchObject({ decision: 'unavailable' });
      await expect(materialization).resolves.toMatchObject({ period: 'day' });
    } finally {
      releaseFirst();
      await Promise.allSettled([first, materialization].filter(Boolean) as Promise<unknown>[]);
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it('orders a global revision writer after an in-flight READ COMMITTED decision', async () => {
    if (!scratch) throw new Error('scratch database is unavailable');
    const builderId = await insertBuilder(db(), 'ledger-revision-writer-lock');
    const account = await insertAccount(db(), builderId);
    const clientA = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    const clientB = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    let releaseDecision!: () => void;
    let signalDecisionReady!: () => void;
    const holdDecision = new Promise<void>((resolve) => {
      releaseDecision = resolve;
    });
    const decisionReady = new Promise<void>((resolve) => {
      signalDecisionReady = resolve;
    });
    let decision: Promise<DecisionFixture> | undefined;
    let rotation:
      | Promise<{ retired: RuleRevisionFixture; successor: RuleRevisionFixture }>
      | undefined;

    try {
      decision = seedDecision(clientA, builderId, {
        account,
        kind: 'unavailable',
        beforeCommit: async () => {
          signalDecisionReady();
          await holdDecision;
        },
      });
      await decisionReady;
      rotation = rotateRuleRevision(clientB, builderId, account.ruleKey, { limitUsd: '30' });
      const observed = await Promise.race([
        rotation.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(observed).toBe('blocked');

      releaseDecision();
      const first = await decision;
      const cutover = await rotation;
      expect(first.ruleRevisionIds).toEqual([account.ruleRevisionId]);
      const afterCutover = await seedDecision(clientA, builderId, {
        account,
        kind: 'unavailable',
      });
      expect(afterCutover.ruleRevisionIds).toEqual([cutover.successor.ruleRevisionId]);
    } finally {
      releaseDecision();
      await Promise.allSettled([decision, rotation].filter(Boolean) as Promise<unknown>[]);
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it('captures the committed successor after waiting behind a revision writer', async () => {
    if (!scratch) throw new Error('scratch database is unavailable');
    const builderId = await insertBuilder(db(), 'ledger-writer-first-cutover');
    const account = await insertAccount(db(), builderId);
    const writerClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    const decisionClient = postgres(scratch.url, { max: 1, onnotice: () => undefined });
    let releaseWriter!: () => void;
    let signalWriterReady!: () => void;
    const holdWriter = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const writerReady = new Promise<void>((resolve) => {
      signalWriterReady = resolve;
    });
    let writer: Promise<RuleRevisionFixture> | undefined;
    let decision: Promise<DecisionFixture> | undefined;

    try {
      writer = writerClient.begin(async (tx) => {
        await useBuilder(tx, builderId);
        const current = await loadLatestRuleRevision(tx, builderId, account.ruleKey);
        const retired = await retireRuleRevision(
          tx,
          builderId,
          current.ruleRevisionId,
          'superseded',
        );
        const successor = await insertRuleRevision(tx, builderId, retired, { limitUsd: '30' });
        signalWriterReady();
        await holdWriter;
        return successor;
      });
      await writerReady;

      decision = seedDecision(decisionClient, builderId, {
        account,
        kind: 'unavailable',
      });
      const observed = await Promise.race([
        decision.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(observed).toBe('blocked');

      releaseWriter();
      const successor = await writer;
      const captured = await decision;
      expect(captured.ruleRevisionIds).toEqual([successor.ruleRevisionId]);
      expect(captured.ruleRevisionIds).not.toContain(account.ruleRevisionId);
    } finally {
      releaseWriter();
      await Promise.allSettled([writer, decision].filter(Boolean) as Promise<unknown>[]);
      await Promise.all([writerClient.end(), decisionClient.end()]);
    }
  });

  it('uses a fresh clock when deferred authorization resumes after its lease expires', async () => {
    const builderId = await insertBuilder(db(), 'ledger-stale-transaction-expiry');
    const nearExpiry = await moveReservedNearExpiry(db(), await seedDecision(db(), builderId));

    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        const [started] = await tx<{ transaction_started_at: Date }[]>`
          SELECT transaction_timestamp() AS transaction_started_at
        `;
        expect(started!.transaction_started_at.getTime()).toBeLessThan(
          Date.parse(nearExpiry.expiresAt!),
        );
        await tx`SELECT pg_sleep(1.6)`;
        await tx`
          SELECT public.pylva_budget_assert_reservation_allocations(
            ${builderId}, ${nearExpiry.decisionId}, TRUE
          )
        `;
      }),
    ).rejects.toThrow(/reservation lease expired before authorization could commit/i);
  });

  it('rejects customer substitution against a per-customer account', async () => {
    const builderId = await insertBuilder(db(), 'ledger-customer-substitution');
    const account = await insertAccount(db(), builderId, {
      scope: 'per_customer',
      subjectCustomerId: 'customer_1',
    });
    await expect(
      seedDecision(db(), builderId, { account, customerId: 'customer_2' }),
    ).rejects.toThrow(/allocation account does not match reservation customer or period/i);
  });

  it('rejects an account whose canonical period does not contain the reservation decision', async () => {
    const builderId = await insertBuilder(db(), 'ledger-period-substitution');
    const account = await insertAccount(db(), builderId, {
      periodStart: FUTURE_PERIOD_START,
      periodEnd: FUTURE_PERIOD_END,
    });
    await expect(seedDecision(db(), builderId, { account })).rejects.toThrow(
      /allocation account does not match reservation customer or period/i,
    );
  });

  it('fails deferred closure when an allocated account crosses its period boundary', async () => {
    const builderId = await insertBuilder(db(), 'ledger-deferred-period-boundary');
    const account = await insertAccount(db(), builderId);
    await expect(
      seedDecision(db(), builderId, {
        account,
        beforeCommit: async (tx) => {
          // Owner-only fault injection. Production backends must not force the
          // deferred closure early and then continue mutating authorization state.
          await tx`ALTER TABLE budget_accounts DISABLE TRIGGER USER`;
          await tx`
            WITH patched AS (
              SELECT id,
                     jsonb_set(
                       jsonb_set(
                         initial_rule_snapshot,
                         '{period_start}',
                         to_jsonb(${FUTURE_PERIOD_START}::text)
                       ),
                       '{period_end}',
                       to_jsonb(${FUTURE_PERIOD_END}::text)
                     ) AS rule_snapshot
              FROM budget_accounts
              WHERE builder_id = ${builderId} AND id = ${account.accountId}
            )
            UPDATE budget_accounts target
            SET period_start = ${FUTURE_PERIOD_START}, period_end = ${FUTURE_PERIOD_END},
                initial_rule_snapshot = patched.rule_snapshot,
                initial_rule_snapshot_hash =
                  public.pylva_budget_jsonb_sha256(patched.rule_snapshot)
            FROM patched
            WHERE target.builder_id = ${builderId} AND target.id = patched.id
          `;
          await tx`ALTER TABLE budget_accounts ENABLE TRIGGER USER`;
        },
      }),
    ).rejects.toThrow(/reserved lifecycle requires matching allocation settlement/i);
  });

  it('rejects rule-key substitution even when the account and snapshot belong to the tenant', async () => {
    const builderId = await insertBuilder(db(), 'ledger-rule-substitution');
    const account = await insertAccount(db(), builderId);
    await expect(
      seedDecision(db(), builderId, { account, allocationRuleKey: crypto.randomUUID() }),
    ).rejects.toThrow(
      /allocation rule revision was not in the reservation rule set|allocation snapshot does not match its locked budget account/i,
    );
  });

  it('rejects an evaluated decision that omits a second applicable account', async () => {
    const builderId = await insertBuilder(db(), 'ledger-allocation-completeness');
    const firstAccount = await insertAccount(db(), builderId);
    await insertAccount(db(), builderId);
    await expect(seedDecision(db(), builderId, { account: firstAccount })).rejects.toThrow(
      /reserved lifecycle requires matching allocation settlement/i,
    );
  });

  it('rejects a same-sized allocation set whose revision identity was substituted', async () => {
    const builderId = await insertBuilder(db(), 'ledger-revision-set-substitution');
    const account = await insertAccount(db(), builderId);
    const reserved = await seedDecision(db(), builderId, { account });
    const { successor } = await rotateRuleRevision(db(), builderId, account.ruleKey, {
      limitUsd: '11',
    });

    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await tx`ALTER TABLE budget_reservation_allocations DISABLE TRIGGER USER`;
        await tx`
          UPDATE budget_reservation_allocations
          SET rule_revision_id = ${successor.ruleRevisionId}
          WHERE builder_id = ${builderId}
            AND reservation_decision_id = ${reserved.decisionId}
        `;
        // The transaction is expected to roll back, which restores the
        // transactional trigger setting. Re-enabling here would be rejected
        // while the UPDATE's deferred foreign-key event is still pending.
        await tx`
          SELECT public.pylva_budget_assert_reservation_allocations(
            ${builderId}, ${reserved.decisionId}, TRUE
          )
        `;
      }),
    ).rejects.toThrow(/reserved lifecycle requires matching allocation settlement/i);
  });

  it('does not apply a later global rule materialization retroactively to an existing reservation', async () => {
    const builderId = await insertBuilder(db(), 'ledger-non-retroactive-account');
    const firstAccount = await insertAccount(db(), builderId);
    const existing = await seedDecision(db(), builderId, { account: firstAccount });

    // Materialize another global rule only after the first authorization
    // transaction captured and closed its exact revision set.
    await insertAccount(db(), builderId);

    const extended = await extendReservation(db(), existing);
    await expect(commitReservation(db(), extended)).resolves.toMatchObject({
      decisionId: existing.decisionId,
    });

    await expect(seedDecision(db(), builderId, { account: firstAccount })).rejects.toThrow(
      /reserved lifecycle requires matching allocation settlement/i,
    );
  });

  it('accepts no_applicable_budget only when the global revision set is truly empty', async () => {
    const falseBuilder = await insertBuilder(db(), 'ledger-false-no-applicable');
    const matchingAccount = await insertAccount(db(), falseBuilder);
    await expect(
      seedDecision(db(), falseBuilder, {
        account: matchingAccount,
        kind: 'no_applicable',
      }),
    ).rejects.toThrow(
      /no_applicable_budget requires an empty applicable global rule revision set/i,
    );

    const disabledBuilder = await insertBuilder(db(), 'ledger-true-no-applicable');
    const futureAccount = await insertAccount(db(), disabledBuilder, {
      periodStart: FUTURE_PERIOD_START,
      periodEnd: FUTURE_PERIOD_END,
    });
    await expect(
      seedDecision(db(), disabledBuilder, {
        account: futureAccount,
        kind: 'no_applicable',
      }),
    ).rejects.toThrow(
      /no_applicable_budget requires an empty applicable global rule revision set/i,
    );
    await db().begin(async (tx) => {
      await useBuilder(tx, disabledBuilder);
      await retireRuleRevision(tx, disabledBuilder, futureAccount.ruleRevisionId!, 'disabled');
    });
    await expect(
      seedDecision(db(), disabledBuilder, {
        account: futureAccount,
        kind: 'no_applicable',
      }),
    ).resolves.toMatchObject({ decision: 'bypassed', ruleRevisionIds: [] });
  });

  it('deduplicates pooled account identity while accepting the same rule in an adjacent day', async () => {
    const builderId = await insertBuilder(db(), 'ledger-account-identity');
    const ruleKey = crypto.randomUUID();
    const first = await insertAccount(db(), builderId, { ruleKey });
    await expect(insertAccount(db(), builderId, { ruleKey })).rejects.toThrow(
      /budget_accounts_natural_identity_uk|duplicate key/i,
    );

    await expect(
      insertAccount(db(), builderId, {
        ruleKey,
        periodStart: first.periodEnd,
        periodEnd: addDays(first.periodEnd, 1),
      }),
    ).resolves.toMatchObject({ ruleKey });
  });

  it('keys reserve idempotency by builder and operation id', async () => {
    const operationId = crypto.randomUUID();
    const builderA = await insertBuilder(db(), 'ledger-operation-a');
    const accountA = await insertAccount(db(), builderA);
    await seedDecision(db(), builderA, { account: accountA, operationId });
    const accountA2 = await insertAccount(db(), builderA);
    await expect(seedDecision(db(), builderA, { account: accountA2, operationId })).rejects.toThrow(
      /budget_reservations_operation_uk|duplicate key/i,
    );

    const builderB = await insertBuilder(db(), 'ledger-operation-b');
    await expect(seedDecision(db(), builderB, { operationId })).resolves.toMatchObject({
      operationId,
    });
  });

  it('rejects NaN, negative amounts, and non-canonical UTC period boundaries', async () => {
    const builderId = await insertBuilder(db(), 'ledger-invalid-account');
    await expect(insertAccount(db(), builderId, { limitUsd: 'NaN' })).rejects.toThrow(
      /budget_rule_revisions_amount_ck|budget_accounts_amounts_ck/i,
    );
    await expect(
      insertAccount(db(), builderId, { openingCommittedUsd: '-0.000000000000000001' }),
    ).rejects.toThrow(/budget_accounts_amounts_ck/i);
    await expect(
      insertAccount(db(), builderId, { openingCommittedUsd: 'Infinity' }),
    ).rejects.toThrow(/budget_accounts_amounts_ck|numeric field overflow/i);
    await expect(
      insertAccount(db(), builderId, {
        periodStart: '2030-01-01T00:00:01.000Z',
        periodEnd: '2030-01-02T00:00:01.000Z',
      }),
    ).rejects.toThrow(/budget_accounts_period_bounds_ck/i);
  });

  it.each([
    ['committed/opening mismatch', { initialCommittedUsd: '1' }],
    ['orphan reserved balance', { initialReservedUsd: '1' }],
    ['orphan unresolved balance', { initialUnresolvedUsd: '1' }],
  ] as const)('rejects a new account with %s', async (_name, overrides) => {
    const builderId = await insertBuilder(db(), 'ledger-invalid-opening');
    await expect(insertAccount(db(), builderId, overrides)).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(
        /new budget accounts must start at their opening committed balance with no active postings/i,
      ),
    });
  });

  it('matches explicit control and blank-only provider identifier semantics', async () => {
    const acceptedBuilder = await insertBuilder(db(), 'ledger-provider-unicode-control');
    const acceptedProvider = `x\u0085y`;
    const accepted = await seedDecision(db(), acceptedBuilder, {
      provider: acceptedProvider,
    });
    const [row] = await db()<{ provider: string; request_provider: string }[]>`
      SELECT provider, request_snapshot->>'provider' AS request_provider
      FROM budget_reservations
      WHERE builder_id = ${acceptedBuilder} AND decision_id = ${accepted.decisionId}
    `;
    expect(row).toEqual({ provider: acceptedProvider, request_provider: acceptedProvider });

    const rejectedBuilder = await insertBuilder(db(), 'ledger-provider-ascii-control');
    await expect(
      seedDecision(db(), rejectedBuilder, { provider: `provider\u001Fedge` }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/budget_reservations_identifiers_ck/i),
    });

    for (const [label, provider] of [
      ['u0085', `\u0085`],
      ['ufeff', `\uFEFF`],
    ] as const) {
      const blankBuilder = await insertBuilder(db(), `ledger-provider-blank-${label}`);
      await expect(seedDecision(db(), blankBuilder, { provider })).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/budget_reservations_identifiers_ck/i),
      });
    }
  });

  it('rejects missing or wrongly typed canonical account snapshot fields', async () => {
    const missingBuilder = await insertBuilder(db(), 'ledger-account-missing-key');
    await expect(
      insertAccount(db(), missingBuilder, {
        ruleSnapshotOverride: { period_end: undefined },
      }),
    ).rejects.toThrow(/budget_accounts_snapshot_ck/i);

    const typeBuilder = await insertBuilder(db(), 'ledger-account-wrong-type');
    await expect(
      insertAccount(db(), typeBuilder, {
        ruleSnapshotOverride: { limit_usd: 10 },
      }),
    ).rejects.toThrow(/budget_accounts_snapshot_ck/i);
  });

  it('rejects numeric schema versions in revision and account evidence', async () => {
    const revisionBuilder = await insertBuilder(db(), 'ledger-revision-schema-type');
    const ruleKey = crypto.randomUUID();
    const revisionSnapshot = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'hard_stop',
      limit_usd: '10',
    };
    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, revisionBuilder);
        await tx`
          WITH candidate AS (
            SELECT jsonb_set(
              ${tx.json(revisionSnapshot)}::jsonb,
              '{schema_version}',
              '1.0'::jsonb
            ) AS snapshot
          )
          INSERT INTO budget_rule_revisions (
            builder_id, id, rule_key, revision, scope, target_customer_id,
            period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
          )
          SELECT ${revisionBuilder}, ${crypto.randomUUID()}, ${ruleKey}, 0,
                 'pooled', NULL, 'day', 'hard_stop', 10,
                 snapshot, public.pylva_budget_jsonb_sha256(snapshot)
          FROM candidate
        `;
      }),
    ).rejects.toThrow(/budget_rule_revisions_snapshot_ck/i);

    const accountBuilder = await insertBuilder(db(), 'ledger-account-schema-type');
    const existing = await insertAccount(db(), accountBuilder);
    const accountSnapshot = {
      schema_version: '1.0',
      rule_key: existing.ruleKey,
      scope: existing.scope,
      subject_customer_id: existing.subjectCustomerId,
      period: existing.period,
      period_start: FUTURE_PERIOD_START,
      period_end: FUTURE_PERIOD_END,
      enforcement: existing.enforcement,
      limit_usd: existing.limitUsd,
      opening_committed_usd: '0',
    };
    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, accountBuilder);
        await tx`
          WITH candidate AS (
            SELECT jsonb_set(
              ${tx.json(accountSnapshot)}::jsonb,
              '{schema_version}',
              '1.0'::jsonb
            ) AS snapshot
          )
          INSERT INTO budget_accounts (
            builder_id, id, rule_key, enforcement, limit_usd, scope,
            subject_customer_id, period, period_start, period_end,
            initial_rule_revision_id, initial_rule_snapshot,
            initial_rule_snapshot_hash, opening_committed_usd
          )
          SELECT ${accountBuilder}, ${crypto.randomUUID()}, ${existing.ruleKey},
                 ${existing.enforcement}, ${existing.limitUsd}, ${existing.scope},
                 ${existing.subjectCustomerId}, ${existing.period},
                 ${FUTURE_PERIOD_START}, ${FUTURE_PERIOD_END},
                 ${existing.ruleRevisionId}, snapshot,
                 public.pylva_budget_jsonb_sha256(snapshot), 0
          FROM candidate
        `;
      }),
    ).rejects.toThrow(/budget_accounts_snapshot_ck/i);
  });

  it('server-normalizes the initial lease and matching reserve response expiry', async () => {
    const builderId = await insertBuilder(db(), 'ledger-initial-expiry');
    const callerExpiry = '2099-01-01T00:00:00.000Z';
    const fixture = await seedDecision(db(), builderId, { expiresAtOverride: callerExpiry });
    const [row] = await db()<{ response_expiry: string }[]>`
      SELECT reserve_response_snapshot->>'expires_at' AS response_expiry
      FROM budget_reservations
      WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}
    `;
    expect(fixture.expiresAt).toBe(addSeconds(fixture.reservedAt!, 300));
    expect(row!.response_expiry).toBe(fixture.expiresAt);
    expect(fixture.expiresAt).not.toBe(callerExpiry);
  });

  it('accepts uppercase UUID wire values while preserving typed UUID identity', async () => {
    const builderId = await insertBuilder(db(), 'ledger-uppercase-uuid');
    const operationId = crypto.randomUUID();
    const fixture = await seedDecision(db(), builderId, {
      operationId,
      requestSnapshotOverride: { operation_id: operationId.toUpperCase() },
    });
    const [row] = await db()<{ operation_id: string; wire_operation_id: string }[]>`
      SELECT operation_id::text, request_snapshot->>'operation_id' AS wire_operation_id
      FROM budget_reservations
      WHERE builder_id = ${builderId} AND decision_id = ${fixture.decisionId}
    `;
    expect(row).toEqual({
      operation_id: operationId,
      wire_operation_id: operationId.toUpperCase(),
    });
  });
});

describe('lifecycle transitions, settlement, and authoritative usage', () => {
  it('atomically commits reservation, allocation, account, usage, transition, and outbox', async () => {
    const builderId = await insertBuilder(db(), 'ledger-commit');
    const reserved = await seedDecision(db(), builderId);
    const committed = await commitReservation(db(), reserved);
    const [row] = await db()<
      {
        account_committed: string;
        account_reserved: string;
        account_version: string;
        actual_cost_usd: string;
        allocation_status: string;
        outbox_exact: boolean;
        outbox_status: string;
        reservation_state: string;
        state_version: string;
        transition_type: string;
      }[]
    >`
      SELECT reservation.state AS reservation_state,
             reservation.state_version::text,
             allocation.status AS allocation_status,
             account.committed_usd::text AS account_committed,
             account.reserved_usd::text AS account_reserved,
             account.version::text AS account_version,
             usage.actual_cost_usd::text,
             transition.type AS transition_type,
             outbox.status AS outbox_status,
             outbox.payload = public.pylva_budget_cost_event_payload(usage) AS outbox_exact
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      JOIN budget_usage_ledger usage
        ON usage.builder_id = reservation.builder_id
       AND usage.reservation_decision_id = reservation.decision_id
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = reservation.builder_id
       AND transition.reservation_decision_id = reservation.decision_id
      JOIN budget_cost_event_outbox outbox
        ON outbox.builder_id = usage.builder_id AND outbox.usage_ledger_id = usage.id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${committed.decisionId}
    `;
    expect(row).toEqual({
      account_committed: '0.750000000000000000',
      account_reserved: '0.000000000000000000',
      account_version: '2',
      actual_cost_usd: '0.750000000000000000',
      allocation_status: 'committed',
      outbox_exact: true,
      outbox_status: 'pending',
      reservation_state: 'committed',
      state_version: '1',
      transition_type: 'commit',
    });
  });

  it('commits configured non-LLM tool cost with reported quantity and the same budget authority', async () => {
    const builderId = await insertBuilder(db(), 'ledger-tool-commit');
    const reserved = await seedDecision(db(), builderId, { usageKind: 'tool' });
    const committed = await commitReservation(db(), reserved);
    const [row] = await db()<
      {
        actual_value: string;
        cost_source: string;
        kind: string;
        metric: string;
        operation: string;
        provider: string;
        tool_name: string;
        transition_matches_usage: boolean;
      }[]
    >`
      SELECT usage.kind, usage.tool_name, usage.metric, usage.actual_value::text,
             usage.cost_source, outbox.payload->>'provider' AS provider,
             outbox.payload->>'operation' AS operation,
             transition.request_snapshot = usage.usage_snapshot
               AS transition_matches_usage
      FROM budget_usage_ledger usage
      JOIN budget_cost_event_outbox outbox
        ON outbox.builder_id = usage.builder_id AND outbox.usage_ledger_id = usage.id
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = usage.builder_id
       AND transition.reservation_decision_id = usage.reservation_decision_id
      WHERE usage.builder_id = ${builderId} AND usage.id = ${committed.usageId!}
    `;
    expect(row).toEqual({
      actual_value: '1.000000000000000000',
      cost_source: 'configured',
      kind: 'tool',
      metric: 'credit',
      operation: 'reported',
      provider: 'other',
      tool_name: 'tavily_search',
      transition_matches_usage: true,
    });
  });

  it('records usage status independently from whether its stream was aborted', async () => {
    const builderId = await insertBuilder(db(), 'ledger-independent-stream-status');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId), {
      usageStatus: 'success',
      usageStreamAborted: true,
    });
    const [row] = await db()<
      {
        outbox_status: string;
        outbox_stream_aborted: boolean;
        status: string;
        stream_aborted: boolean;
        transition_status: string;
        transition_stream_aborted: boolean;
      }[]
    >`
      SELECT usage.status, usage.stream_aborted,
             transition.request_snapshot->>'status' AS transition_status,
             (transition.request_snapshot->>'stream_aborted')::boolean
               AS transition_stream_aborted,
             outbox.payload->>'status' AS outbox_status,
             (outbox.payload->>'stream_aborted')::boolean AS outbox_stream_aborted
      FROM budget_usage_ledger usage
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = usage.builder_id
       AND transition.reservation_decision_id = usage.reservation_decision_id
      JOIN budget_cost_event_outbox outbox
        ON outbox.builder_id = usage.builder_id AND outbox.usage_ledger_id = usage.id
      WHERE usage.builder_id = ${builderId} AND usage.id = ${committed.usageId!}
    `;
    expect(row).toEqual({
      outbox_status: 'success',
      outbox_stream_aborted: true,
      status: 'success',
      stream_aborted: true,
      transition_status: 'success',
      transition_stream_aborted: true,
    });
  });

  it('rejects a commit transaction that omits its transactional outbox', async () => {
    const builderId = await insertBuilder(db(), 'ledger-missing-outbox');
    const reserved = await seedDecision(db(), builderId);
    await expect(commitReservation(db(), reserved, { insertOutbox: false })).rejects.toThrow(
      /authoritative usage requires a transactional outbox row/i,
    );
  });

  it('rejects a committed reservation that omits authoritative usage', async () => {
    const builderId = await insertBuilder(db(), 'ledger-missing-usage');
    const reserved = await seedDecision(db(), builderId);
    await expect(commitReservation(db(), reserved, { insertUsage: false })).rejects.toThrow(
      /committed reservation requires authoritative usage|commit transition request does not match authoritative usage/i,
    );
  });

  it('rejects settlement without the matching lifecycle transition', async () => {
    const builderId = await insertBuilder(db(), 'ledger-missing-transition');
    const reserved = await seedDecision(db(), builderId);
    await expect(commitReservation(db(), reserved, { insertTransition: false })).rejects.toThrow(
      /reservation state, version, or expiry does not match transition chain/i,
    );
  });

  it('rejects an outbox payload that is not the deterministic usage projection', async () => {
    const builderId = await insertBuilder(db(), 'ledger-wrong-outbox');
    const reserved = await seedDecision(db(), builderId);
    await expect(
      commitReservation(db(), reserved, {
        outboxPayloadOverride: { cost_usd: '999' },
      }),
    ).rejects.toThrow(/transactional outbox payload does not match authoritative usage/i);
  });

  it('rejects commit transition request and response snapshot mismatches', async () => {
    const requestBuilder = await insertBuilder(db(), 'ledger-commit-request');
    const requestReservation = await seedDecision(db(), requestBuilder);
    await expect(
      commitReservation(db(), requestReservation, {
        transitionRequestOverride: { actual_output_tokens: 51 },
      }),
    ).rejects.toThrow(/commit transition request does not match authoritative usage/i);

    const responseBuilder = await insertBuilder(db(), 'ledger-commit-response');
    const responseReservation = await seedDecision(db(), responseBuilder);
    await expect(
      commitReservation(db(), responseReservation, {
        transitionResponseOverride: { released_usd: '0.24' },
      }),
    ).rejects.toThrow(/commit transition response does not match settlement/i);

    const missingBuilder = await insertBuilder(db(), 'ledger-commit-missing-key');
    await expect(
      commitReservation(db(), await seedDecision(db(), missingBuilder), {
        transitionRequestOverride: { status: undefined },
      }),
    ).rejects.toThrow(/commit transition request does not match authoritative usage/i);

    const typeBuilder = await insertBuilder(db(), 'ledger-commit-wrong-type');
    await expect(
      commitReservation(db(), await seedDecision(db(), typeBuilder), {
        transitionRequestOverride: { latency_ms: '250' },
      }),
    ).rejects.toThrow(/commit transition request does not match authoritative usage/i);
  });

  it.each([
    ['customer context', { usageCustomerId: 'customer_2' }],
    ['actual cost', { usageActualCostUsd: '0.76' }],
    ['pricing snapshot', { usagePricingSnapshotOverride: { ...PRICING_SNAPSHOT, revision: 2 } }],
  ] as const)('rejects authoritative usage with mismatched %s', async (name, overrides) => {
    const builderId = await insertBuilder(db(), `ledger-usage-${name}`);
    const reserved = await seedDecision(db(), builderId);
    await expect(commitReservation(db(), reserved, overrides)).rejects.toThrow(
      /authoritative usage does not match its committed reservation|committed reservation does not match authoritative usage/i,
    );
  });

  it('ignores future-dated no-op timestamps without poisoning later settlement', async () => {
    const builderId = await insertBuilder(db(), 'ledger-future-noop-timestamp');
    const reserved = await seedDecision(db(), builderId);
    await useBuilder(db(), builderId);
    const [before] = await db()<{ allocation_updated_at: Date; reservation_updated_at: Date }[]>`
      SELECT reservation.updated_at AS reservation_updated_at,
             allocation.updated_at AS allocation_updated_at
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${reserved.decisionId}
    `;

    await db()`
      UPDATE budget_reservations
      SET updated_at = '9999-12-31T23:59:59.999Z'
      WHERE builder_id = ${builderId} AND decision_id = ${reserved.decisionId}
    `;
    await db()`
      UPDATE budget_reservation_allocations
      SET updated_at = '9999-12-31T23:59:59.999Z'
      WHERE builder_id = ${builderId}
        AND reservation_decision_id = ${reserved.decisionId}
    `;

    const [after] = await db()<{ allocation_updated_at: Date; reservation_updated_at: Date }[]>`
      SELECT reservation.updated_at AS reservation_updated_at,
             allocation.updated_at AS allocation_updated_at
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${reserved.decisionId}
    `;
    expect(after!.reservation_updated_at.getTime()).toBe(before!.reservation_updated_at.getTime());
    expect(after!.allocation_updated_at.getTime()).toBe(before!.allocation_updated_at.getTime());
    await expect(commitReservation(db(), reserved)).resolves.toMatchObject({
      decisionId: reserved.decisionId,
    });
  });

  it('releases a live reservation and reverses the complete hold', async () => {
    const builderId = await insertBuilder(db(), 'ledger-live-release');
    const reserved = await seedDecision(db(), builderId);
    await releaseReservation(db(), reserved);
    const [row] = await db()<
      {
        released_usd: string;
        reserved_usd: string;
        state: string;
        status: string;
        version: string;
      }[]
    >`
      SELECT reservation.state, reservation.released_usd::text,
             allocation.status, account.reserved_usd::text,
             account.version::text
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${reserved.decisionId}
    `;
    expect(row).toEqual({
      released_usd: '1.000000000000000000',
      reserved_usd: '0.000000000000000000',
      state: 'released',
      status: 'released',
      version: '2',
    });
  });

  it('rejects a direct terminal transition at expiry, then accepts expire-unresolved and late commit', async () => {
    const directBuilder = await insertBuilder(db(), 'ledger-direct-expired');
    const direct = await backdateReservedForExpiry(db(), await seedDecision(db(), directBuilder));
    await expect(releaseReservation(db(), direct)).rejects.toThrow(
      /budget_reservation_transitions_expiry_ck/i,
    );

    const lateBuilder = await insertBuilder(db(), 'ledger-late-commit');
    const reserved = await backdateReservedForExpiry(db(), await seedDecision(db(), lateBuilder));
    const unresolved = await expireReservation(db(), reserved);
    await commitReservation(db(), unresolved);
    const [row] = await db()<
      {
        committed_usd: string;
        reserved_usd: string;
        state: string;
        state_version: string;
        unresolved_usd: string;
        version: string;
      }[]
    >`
      SELECT reservation.state, reservation.state_version::text,
             account.committed_usd::text, account.reserved_usd::text,
             account.unresolved_usd::text, account.version::text
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      WHERE reservation.builder_id = ${lateBuilder}
        AND reservation.decision_id = ${reserved.decisionId}
    `;
    expect(row).toEqual({
      committed_usd: '0.750000000000000000',
      reserved_usd: '0.000000000000000000',
      state: 'committed',
      state_version: '2',
      unresolved_usd: '0.000000000000000000',
      version: '3',
    });
  });

  it('server-normalizes poisoned settlement timestamps across authoritative evidence', async () => {
    const builderId = await insertBuilder(db(), 'ledger-client-backdate');
    const reserved = await seedDecision(db(), builderId);
    const beforeCommit = Date.now();
    const committed = await commitReservation(db(), reserved, {
      committedAt: PAST_COMMITTED_AT,
    });
    const afterCommit = Date.now();
    const [row] = await db()<
      {
        account_updated_at: Date;
        allocation_updated_at: Date;
        outbox_created_at: Date;
        outbox_updated_at: Date;
        reservation_committed_at: Date;
        reservation_updated_at: Date;
        response_committed_at: string;
        transition_occurred_at: Date;
        usage_committed_at: Date;
        usage_created_at: Date;
      }[]
    >`
      SELECT reservation.committed_at AS reservation_committed_at,
             reservation.updated_at AS reservation_updated_at,
             allocation.updated_at AS allocation_updated_at,
             account.updated_at AS account_updated_at,
             transition.occurred_at AS transition_occurred_at,
             transition.response_snapshot->>'committed_at' AS response_committed_at,
             usage.committed_at AS usage_committed_at,
             usage.created_at AS usage_created_at,
             outbox.created_at AS outbox_created_at,
             outbox.updated_at AS outbox_updated_at
      FROM budget_reservations reservation
      JOIN budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
      JOIN budget_accounts account
        ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = reservation.builder_id
       AND transition.reservation_decision_id = reservation.decision_id
      JOIN budget_usage_ledger usage
        ON usage.builder_id = reservation.builder_id
       AND usage.reservation_decision_id = reservation.decision_id
      JOIN budget_cost_event_outbox outbox
        ON outbox.builder_id = usage.builder_id AND outbox.usage_ledger_id = usage.id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${committed.decisionId}
    `;

    const canonicalTime = row!.reservation_committed_at.toISOString();
    expect(canonicalTime).not.toBe(PAST_COMMITTED_AT);
    expect(row!.transition_occurred_at.toISOString()).toBe(canonicalTime);
    expect(row!.usage_committed_at.toISOString()).toBe(canonicalTime);
    expect(row!.response_committed_at).toBe(canonicalTime);
    expect(row!.usage_created_at.getTime()).toBeGreaterThanOrEqual(
      row!.usage_committed_at.getTime(),
    );
    expect(row!.usage_created_at.toISOString()).not.toBe(PAST_COMMITTED_AT);
    for (const timestamp of [
      row!.reservation_committed_at,
      row!.reservation_updated_at,
      row!.allocation_updated_at,
      row!.account_updated_at,
      row!.transition_occurred_at,
      row!.usage_committed_at,
      row!.usage_created_at,
      row!.outbox_created_at,
      row!.outbox_updated_at,
    ]) {
      expect(timestamp.getTime()).toBeGreaterThanOrEqual(beforeCommit);
      expect(timestamp.getTime()).toBeLessThanOrEqual(afterCommit);
    }
  });

  it('extends only through a canonical versioned transition and retains the initial reserve response', async () => {
    const builderId = await insertBuilder(db(), 'ledger-extension');
    const reserved = await seedDecision(db(), builderId);
    const extended = await extendReservation(db(), reserved);
    const [row] = await db()<
      {
        current_expiry: Date;
        initial_response_expiry: string;
        state_version: string;
        transition_expiry: Date;
      }[]
    >`
      SELECT reservation.expires_at AS current_expiry,
             reservation.reserve_response_snapshot->>'expires_at' AS initial_response_expiry,
             reservation.state_version::text,
             transition.to_expires_at AS transition_expiry
      FROM budget_reservations reservation
      JOIN budget_reservation_transitions transition
        ON transition.builder_id = reservation.builder_id
       AND transition.reservation_decision_id = reservation.decision_id
      WHERE reservation.builder_id = ${builderId}
        AND reservation.decision_id = ${reserved.decisionId}
    `;
    expect(row!.initial_response_expiry).toBe(reserved.expiresAt);
    expect(row!.current_expiry.toISOString()).toBe(extended.expiresAt);
    expect(row!.transition_expiry.toISOString()).toBe(extended.expiresAt);
    expect(row!.state_version).toBe('1');
  });

  it('accepts uppercase UUID wire values in extension snapshots', async () => {
    const builderId = await insertBuilder(db(), 'ledger-uppercase-extension');
    const extended = await extendReservation(db(), await seedDecision(db(), builderId), 60, true);
    const [row] = await db()<
      { extension_id: string; request_extension_id: string; response_operation_id: string }[]
    >`
      SELECT extension_id::text,
             request_snapshot->>'extension_id' AS request_extension_id,
             response_snapshot->>'operation_id' AS response_operation_id
      FROM budget_reservation_transitions
      WHERE builder_id = ${builderId} AND id = ${extended.transitionId!}
    `;
    expect(row!.request_extension_id).toBe(row!.extension_id.toUpperCase());
    expect(row!.response_operation_id).toBe(extended.operationId.toUpperCase());
  });

  it('rejects extension deltas outside the 30-to-3,600-second contract', async () => {
    const shortBuilder = await insertBuilder(db(), 'ledger-extension-short');
    await expect(
      extendReservation(db(), await seedDecision(db(), shortBuilder), 29),
    ).rejects.toThrow(/only a live reservation lease may be extended|expiry_ck/i);

    const longBuilder = await insertBuilder(db(), 'ledger-extension-long');
    await expect(
      extendReservation(db(), await seedDecision(db(), longBuilder), 3_601),
    ).rejects.toThrow(/only a live reservation lease may be extended|expiry_ck/i);
  });

  it('enforces exactly one outbox identity per usage row', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-idempotency');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await useBuilder(db(), builderId);
    await expect(
      db()`
        INSERT INTO budget_cost_event_outbox (
          builder_id, id, usage_ledger_id, cost_event_id,
          payload_schema_version, payload, payload_hash
        )
        SELECT builder_id, ${crypto.randomUUID()}, usage_ledger_id, cost_event_id,
               payload_schema_version, payload, payload_hash
        FROM budget_cost_event_outbox
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toThrow(/budget_cost_event_outbox_usage_uk|duplicate key/i);
  });
});

describe('outbox worker lifecycle and retention tombstones', () => {
  it('requires a real claim with a bounded lease before projection', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-lease');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await useBuilder(db(), builderId);

    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await tx`
          UPDATE budget_cost_event_outbox
          SET status = 'processing', attempts = attempts + 1
          WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        `;
      }),
    ).rejects.toThrow(/claiming an outbox row requires app.outbox_worker_id/i);

    await expect(
      db()`
        UPDATE budget_cost_event_outbox
        SET status = 'projected', projected_at = transaction_timestamp()
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toThrow(/illegal budget_cost_event_outbox lifecycle transition/i);
  });

  it.each(['', ' ', '\t'])(
    'rejects a blank outbox worker identity with SQLSTATE 42501',
    async (workerId) => {
      const builderId = await insertBuilder(db(), 'ledger-outbox-blank-worker');
      const committed = await commitReservation(db(), await seedDecision(db(), builderId));
      await expect(claimOutbox(db(), committed, workerId)).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('server-stamps a clean one-minute claim instead of trusting caller lease fields', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-server-lease');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    const beforeClaim = Date.now();
    const lease = await claimOutbox(db(), committed, 'authoritative-worker');
    const afterClaim = Date.now();
    const [row] = await db()<
      {
        attempts: number;
        last_error_code: string | null;
        last_error_message: string | null;
      }[]
    >`
      SELECT attempts, last_error_code, last_error_message
      FROM budget_cost_event_outbox
      WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
    `;

    expect(lease.lockOwner).toBe('authoritative-worker');
    expect(Date.parse(lease.lockedAt)).toBeGreaterThanOrEqual(beforeClaim);
    expect(Date.parse(lease.lockedAt)).toBeLessThanOrEqual(afterClaim);
    expect(Date.parse(lease.lockExpiresAt) - Date.parse(lease.lockedAt)).toBe(60_000);
    expect(lease.lastAttemptAt).toBe(lease.lockedAt);
    expect(row).toEqual({ attempts: 1, last_error_code: null, last_error_message: null });
  });

  it('clamps a far-future retry request to five minutes from the fresh release clock', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-retry-clamp');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    const claim = await claimOutbox(db(), committed, 'retry-clamp-worker');
    const beforeRelease = Date.now();
    const released = await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await useOutboxWorker(tx, 'retry-clamp-worker');
      const [row] = await tx<{ available_at: Date; last_attempt_at: Date }[]>`
        UPDATE budget_cost_event_outbox
        SET status = 'pending', available_at = '2099-01-01T00:00:00.000Z'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        RETURNING available_at, last_attempt_at
      `;
      return row!;
    });
    const afterRelease = Date.now();

    expect(released.available_at.getTime()).toBeGreaterThanOrEqual(beforeRelease + 300_000);
    expect(released.available_at.getTime()).toBeLessThanOrEqual(afterRelease + 300_000);
    expect(released.available_at.toISOString()).not.toBe('2099-01-01T00:00:00.000Z');
    expect(released.last_attempt_at.toISOString()).toBe(claim.lastAttemptAt);

    await useBuilder(db(), builderId);
    await expect(
      db()`
        UPDATE budget_cost_event_outbox
        SET last_attempt_at = last_attempt_at + INTERVAL '1 second',
            last_error_code = 'POISON', last_error_message = 'poison'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toMatchObject({
      code: '55000',
      message: expect.stringMatching(/pending outbox rows may change only when claimed/i),
    });
  });

  it('refuses an early retry claim and allows it after bounded availability', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-retry-availability');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await claimOutbox(db(), committed, 'retry-owner');
    const scheduledAt = await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await useOutboxWorker(tx, 'retry-owner');
      const [row] = await tx<{ available_at: Date }[]>`
        UPDATE budget_cost_event_outbox
        SET status = 'pending',
            available_at = clock_timestamp() + INTERVAL '1 second'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        RETURNING available_at
      `;
      return row!.available_at;
    });

    expect(scheduledAt.getTime()).toBeGreaterThan(Date.now());
    await expect(claimOutbox(db(), committed, 'early-retry-worker')).rejects.toThrow(
      /outbox row is not available for another attempt yet/i,
    );
    await db()`SELECT pg_sleep(1.1)`;
    await expect(claimOutbox(db(), committed, 'ready-retry-worker')).resolves.toMatchObject({
      lockOwner: 'ready-retry-worker',
    });
  });

  it('rejects an active foreign release while allowing the owner to project', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-owner');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    const claim = await claimOutbox(db(), committed, 'worker-one');

    await expect(
      db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        await useOutboxWorker(tx, 'worker-two');
        await tx`
          UPDATE budget_cost_event_outbox
          SET status = 'pending'
          WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        `;
      }),
    ).rejects.toThrow(/only the active outbox owner may release an unexpired lease/i);

    const beforeProjection = Date.now();
    const projectedAt = await projectClaimedOutbox(db(), committed, 'worker-one');
    const afterProjection = Date.now();
    const [projected] = await db()<
      {
        lock_expires_at: Date | null;
        lock_owner: string | null;
        locked_at: Date | null;
        last_attempt_at: Date;
        status: string;
      }[]
    >`
      SELECT status, locked_at, lock_expires_at, lock_owner, last_attempt_at
      FROM budget_cost_event_outbox
      WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
    `;
    expect(Date.parse(projectedAt)).toBeGreaterThanOrEqual(beforeProjection);
    expect(Date.parse(projectedAt)).toBeLessThanOrEqual(afterProjection);
    expect(projected).toEqual({
      lock_expires_at: null,
      lock_owner: null,
      locked_at: null,
      last_attempt_at: new Date(claim.lastAttemptAt),
      status: 'projected',
    });
  });

  it('renews only the active owner lease while preserving claim identity', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-renewal');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    const original = await claimOutbox(db(), committed, 'renewing-worker');
    const renewed = await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await useOutboxWorker(tx, 'renewing-worker');
      const [row] = await tx<
        {
          last_error_code: string | null;
          last_error_message: string | null;
          last_attempt_at: Date;
          locked_at: Date;
          lock_expires_at: Date;
          lock_owner: string;
        }[]
      >`
        UPDATE budget_cost_event_outbox
        SET lock_expires_at = '2099-01-01T00:00:00.000Z',
            last_error_code = 'POISON', last_error_message = 'poison'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        RETURNING locked_at, lock_expires_at, lock_owner, last_attempt_at,
                  last_error_code, last_error_message
      `;
      return row!;
    });

    expect(renewed.lock_owner).toBe(original.lockOwner);
    expect(renewed.locked_at.toISOString()).toBe(original.lockedAt);
    expect(renewed.last_attempt_at.toISOString()).toBe(original.lastAttemptAt);
    expect(renewed.last_error_code).toBeNull();
    expect(renewed.last_error_message).toBeNull();
    expect(renewed.lock_expires_at.getTime()).toBeGreaterThan(Date.parse(original.lockExpiresAt));
    expect(renewed.lock_expires_at.getTime() - renewed.locked_at.getTime()).toBeLessThanOrEqual(
      300_000,
    );
  });

  it('advances renewal monotonically when the one-minute clock target is not later', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-renewal-floor');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await claimOutbox(db(), committed, 'floor-worker');
    const forcedExpiry = await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await tx`ALTER TABLE budget_cost_event_outbox DISABLE TRIGGER USER`;
      const [row] = await tx<{ lock_expires_at: Date }[]>`
        UPDATE budget_cost_event_outbox
        SET lock_expires_at = locked_at + INTERVAL '2 minutes'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        RETURNING lock_expires_at
      `;
      await tx`ALTER TABLE budget_cost_event_outbox ENABLE TRIGGER USER`;
      return row!.lock_expires_at;
    });

    const renewedExpiry = await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await useOutboxWorker(tx, 'floor-worker');
      const [row] = await tx<{ lock_expires_at: Date }[]>`
        UPDATE budget_cost_event_outbox
        SET lock_expires_at = lock_expires_at
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
        RETURNING lock_expires_at
      `;
      return row!.lock_expires_at;
    });

    expect(renewedExpiry.getTime()).toBe(forcedExpiry.getTime() + 1);
  });

  it('treats the exact lease-expiry boundary as expired for projection', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-expiry-boundary');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await claimOutbox(db(), committed, 'boundary-worker');
    await db()`SELECT pg_sleep(0.002)`;
    await useBuilder(db(), builderId);

    await expect(
      db()`
        DO $boundary$
        DECLARE
          boundary_time timestamptz := date_trunc('milliseconds', statement_timestamp());
        BEGIN
          ALTER TABLE budget_cost_event_outbox DISABLE TRIGGER USER;
          UPDATE budget_cost_event_outbox
          SET locked_at = created_at,
              last_attempt_at = created_at,
              lock_expires_at = boundary_time
          WHERE status = 'processing';
          ALTER TABLE budget_cost_event_outbox ENABLE TRIGGER USER;

          PERFORM set_config('app.outbox_worker_id', 'boundary-worker', true);
          UPDATE budget_cost_event_outbox
          SET status = 'projected'
          WHERE status = 'processing';
        END
        $boundary$;
      `,
    ).rejects.toThrow(/only the active unexpired outbox owner may project an event/i);

    const [guard] = await db()<{ inclusive_expiry_checks: string }[]>`
      SELECT regexp_count(
        pg_get_functiondef('public.pylva_budget_outbox_immutability_guard()'::regprocedure),
        'authoritative_now >= OLD[.]lock_expires_at'
      )::text AS inclusive_expiry_checks
    `;
    expect(guard!.inclusive_expiry_checks).toBe('2');
  });

  it('allows another worker to recover a lease only after authoritative expiry', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-expired-recovery');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await claimOutbox(db(), committed, 'expired-worker');

    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      // Owner-only setup creates an already-expired lease without waiting.
      await tx`ALTER TABLE budget_cost_event_outbox DISABLE TRIGGER USER`;
      await tx`
        UPDATE budget_cost_event_outbox
        SET created_at = created_at - INTERVAL '5 minutes',
            locked_at = created_at - INTERVAL '4 minutes',
            last_attempt_at = created_at - INTERVAL '4 minutes',
            lock_expires_at = created_at - INTERVAL '3 minutes'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `;
      await tx`ALTER TABLE budget_cost_event_outbox ENABLE TRIGGER USER`;
    });

    await useBuilder(db(), builderId);
    await expect(
      db()`
        UPDATE budget_cost_event_outbox
        SET status = 'pending'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toMatchObject({
      code: '42501',
      message: expect.stringMatching(/processing an outbox row requires app.outbox_worker_id/i),
    });

    await db().begin(async (tx) => {
      await useBuilder(tx, builderId);
      await useOutboxWorker(tx, 'recovery-worker');
      await tx`
        UPDATE budget_cost_event_outbox
        SET status = 'pending'
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `;
    });
    const [recovered] = await db()<
      {
        lock_expires_at: Date | null;
        lock_owner: string | null;
        locked_at: Date | null;
        status: string;
      }[]
    >`
      SELECT status, locked_at, lock_expires_at, lock_owner
      FROM budget_cost_event_outbox
      WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
    `;
    expect(recovered).toEqual({
      lock_expires_at: null,
      lock_owner: null,
      locked_at: null,
      status: 'pending',
    });
  });

  it('allows reconciliation verification only after a successful projection', async () => {
    const builderId = await insertBuilder(db(), 'ledger-outbox-verification');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await useBuilder(db(), builderId);
    await expect(
      db()`
        UPDATE budget_cost_event_outbox
        SET projection_verified_at = transaction_timestamp()
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toThrow(/only a projected payload can become reconciliation-verified/i);

    await projectOutbox(db(), committed);
    await expect(verifyOutboxProjection(db(), committed)).resolves.toBeUndefined();
  });

  it('rejects purge before retention and before projection verification', async () => {
    const futureBuilder = await insertBuilder(db(), 'ledger-purge-too-soon');
    const future = await commitReservation(db(), await seedDecision(db(), futureBuilder));
    await useBuilder(db(), futureBuilder);
    await expect(
      db()`
        UPDATE budget_usage_ledger
        SET pricing_snapshot = NULL, usage_snapshot = NULL, metadata = NULL
        WHERE builder_id = ${futureBuilder} AND id = ${future.usageId!}
      `,
    ).rejects.toThrow(/authoritative usage details are still within retention/i);

    const pastBuilder = await insertBuilder(db(), 'ledger-purge-unverified');
    const past = await seedPastCommitted(db(), pastBuilder);
    await projectOutbox(db(), past);
    await useBuilder(db(), pastBuilder);
    await expect(
      db()`
        UPDATE budget_usage_ledger
        SET pricing_snapshot = NULL, usage_snapshot = NULL, metadata = NULL
        WHERE builder_id = ${pastBuilder} AND id = ${past.usageId!}
      `,
    ).rejects.toThrow(/require a reconciliation-verified projection before purge/i);
  });

  it('rejects either side of a retention purge when committed alone', async () => {
    const usageBuilder = await insertBuilder(db(), 'ledger-purge-usage-alone');
    const usageFixture = await seedPastCommitted(db(), usageBuilder);
    await projectAndVerifyOutbox(db(), usageFixture);
    await useBuilder(db(), usageBuilder);
    await expect(
      db()`
        UPDATE budget_usage_ledger
        SET pricing_snapshot = NULL, usage_snapshot = NULL, metadata = NULL
        WHERE builder_id = ${usageBuilder} AND id = ${usageFixture.usageId!}
      `,
    ).rejects.toThrow(/usage details and outbox payload must be purged atomically/i);

    const outboxBuilder = await insertBuilder(db(), 'ledger-purge-outbox-alone');
    const outboxFixture = await seedPastCommitted(db(), outboxBuilder);
    await projectAndVerifyOutbox(db(), outboxFixture);
    await useBuilder(db(), outboxBuilder);
    await expect(
      db()`
        UPDATE budget_cost_event_outbox
        SET payload = NULL
        WHERE builder_id = ${outboxBuilder} AND id = ${outboxFixture.outboxId!}
      `,
    ).rejects.toThrow(/usage details and outbox payload must be purged atomically/i);
  });

  it.each(['usage-first', 'outbox-first'] as const)(
    'atomically creates immutable tombstones in %s statement order',
    async (order) => {
      const builderId = await insertBuilder(db(), `ledger-purge-${order}`);
      const fixture = await seedPastCommitted(db(), builderId);
      await projectAndVerifyOutbox(db(), fixture);
      await useBuilder(db(), builderId);
      const [before] = await db()<
        { payload_hash: string; pricing_snapshot_hash: string; usage_snapshot_hash: string }[]
      >`
        SELECT outbox.payload_hash, usage.pricing_snapshot_hash, usage.usage_snapshot_hash
        FROM budget_usage_ledger usage
        JOIN budget_cost_event_outbox outbox
          ON outbox.builder_id = usage.builder_id AND outbox.usage_ledger_id = usage.id
        WHERE usage.builder_id = ${builderId} AND usage.id = ${fixture.usageId!}
      `;

      await db().begin(async (tx) => {
        await useBuilder(tx, builderId);
        const purgeUsage = async (): Promise<void> => {
          await tx`
            UPDATE budget_usage_ledger
            SET pricing_snapshot = NULL, usage_snapshot = NULL, metadata = NULL
            WHERE builder_id = ${builderId} AND id = ${fixture.usageId!}
          `;
        };
        const purgeOutbox = async (): Promise<void> => {
          await tx`
            UPDATE budget_cost_event_outbox
            SET payload = NULL
            WHERE builder_id = ${builderId} AND id = ${fixture.outboxId!}
          `;
        };
        if (order === 'usage-first') {
          await purgeUsage();
          await purgeOutbox();
        } else {
          await purgeOutbox();
          await purgeUsage();
        }
      });

      const [after] = await db()<
        {
          details_purged_at: Date;
          metadata: JsonObject | null;
          payload: JsonObject | null;
          payload_hash: string;
          payload_purged_at: Date;
          pricing_snapshot: JsonObject | null;
          pricing_snapshot_hash: string;
          usage_snapshot: JsonObject | null;
          usage_snapshot_hash: string;
        }[]
      >`
        SELECT usage.pricing_snapshot, usage.usage_snapshot, usage.metadata,
               usage.details_purged_at, usage.pricing_snapshot_hash,
               usage.usage_snapshot_hash, outbox.payload, outbox.payload_purged_at,
               outbox.payload_hash
        FROM budget_usage_ledger usage
        JOIN budget_cost_event_outbox outbox
          ON outbox.builder_id = usage.builder_id AND outbox.usage_ledger_id = usage.id
        WHERE usage.builder_id = ${builderId} AND usage.id = ${fixture.usageId!}
      `;
      expect(after).toMatchObject({
        metadata: null,
        payload: null,
        payload_hash: before!.payload_hash,
        pricing_snapshot: null,
        pricing_snapshot_hash: before!.pricing_snapshot_hash,
        usage_snapshot: null,
        usage_snapshot_hash: before!.usage_snapshot_hash,
      });
      expect(after!.details_purged_at.getTime()).toBe(after!.payload_purged_at.getTime());

      await useBuilder(db(), builderId);
      await expect(
        db()`
          UPDATE budget_usage_ledger SET metadata = '{}'::jsonb
          WHERE builder_id = ${builderId} AND id = ${fixture.usageId!}
        `,
      ).rejects.toThrow(/purged authoritative usage tombstones are immutable/i);
      await expect(
        db()`
          UPDATE budget_cost_event_outbox SET attempts = attempts + 1
          WHERE builder_id = ${builderId} AND id = ${fixture.outboxId!}
        `,
      ).rejects.toThrow(/purged outbox tombstones are immutable/i);
    },
  );
});

describe('tamper resistance and exactly-once lifecycle identities', () => {
  it('rejects direct account-counter tampering even with a plausible version increment', async () => {
    const builderId = await insertBuilder(db(), 'ledger-counter-tamper');
    const reserved = await seedDecision(db(), builderId);
    await useBuilder(db(), builderId);
    const [posted] = await db()<{ reserved_usd: string; version: string }[]>`
      SELECT reserved_usd::text, version::text
      FROM budget_accounts
      WHERE builder_id = ${builderId} AND id = ${reserved.account.accountId}
    `;
    expect(posted).toEqual({ reserved_usd: '1.000000000000000000', version: '1' });

    await expect(
      db()`
        UPDATE budget_accounts
        SET committed_usd = committed_usd + 1, version = version + 1,
            updated_at = transaction_timestamp()
        WHERE builder_id = ${builderId} AND id = ${reserved.account.accountId}
      `,
    ).rejects.toMatchObject({
      code: '55000',
      message: expect.stringMatching(
        /budget account postings may change only from the allocation posting trigger/i,
      ),
    });

    await expect(
      db()`
        UPDATE budget_accounts
        SET version = version + 1, updated_at = transaction_timestamp()
        WHERE builder_id = ${builderId} AND id = ${reserved.account.accountId}
      `,
    ).rejects.toThrow(
      /allocation posting trigger|version-only|posting cause|version may change only/i,
    );
  });

  it('rejects allocation or reservation settlement that bypasses the complete closure', async () => {
    const builderId = await insertBuilder(db(), 'ledger-settlement-tamper');
    const reserved = await seedDecision(db(), builderId);
    await useBuilder(db(), builderId);
    await expect(
      db()`
        UPDATE budget_reservation_allocations
        SET status = 'released', released_usd = authorized_usd,
            updated_at = transaction_timestamp()
        WHERE builder_id = ${builderId} AND id = ${reserved.allocationId!}
      `,
    ).rejects.toThrow(/reserved lifecycle requires matching allocation settlement/i);

    await expect(
      db()`
        UPDATE budget_reservations
        SET state = 'released', released_usd = reserved_usd,
            released_at = transaction_timestamp(), state_version = state_version + 1,
            updated_at = transaction_timestamp()
        WHERE builder_id = ${builderId} AND decision_id = ${reserved.decisionId}
      `,
    ).rejects.toThrow(
      /reservation state, version, or expiry does not match transition chain|reserved lifecycle requires matching allocation settlement/i,
    );
  });

  it('keeps rule, request, allocation, transition, usage, and outbox evidence immutable', async () => {
    const builderId = await insertBuilder(db(), 'ledger-immutability');
    const committed = await commitReservation(db(), await seedDecision(db(), builderId));
    await useBuilder(db(), builderId);
    const otherHash = 'f'.repeat(64);

    await expect(
      db()`
        UPDATE budget_accounts SET initial_rule_snapshot_hash = ${otherHash}
        WHERE builder_id = ${builderId} AND id = ${committed.account.accountId}
      `,
    ).rejects.toThrow(/budget_accounts identity and snapshots are immutable/i);
    await expect(
      db()`
        UPDATE budget_reservations SET request_hash = ${otherHash}
        WHERE builder_id = ${builderId} AND decision_id = ${committed.decisionId}
      `,
    ).rejects.toThrow(/request, decision, and pricing snapshots are immutable/i);
    await expect(
      db()`
        UPDATE budget_reservation_allocations SET rule_snapshot_hash = ${otherHash}
        WHERE builder_id = ${builderId} AND id = ${committed.allocationId!}
      `,
    ).rejects.toThrow(/decision snapshot is immutable/i);
    await expect(
      db()`
        UPDATE budget_reservation_transitions SET request_hash = ${otherHash}
        WHERE builder_id = ${builderId} AND id = ${committed.transitionId!}
      `,
    ).rejects.toThrow(/append-only and immutable/i);
    await expect(
      db()`
        UPDATE budget_usage_ledger SET usage_snapshot_hash = ${otherHash}
        WHERE builder_id = ${builderId} AND id = ${committed.usageId!}
      `,
    ).rejects.toThrow(/usage updates may only remove retained JSON details/i);
    await expect(
      db()`
        UPDATE budget_cost_event_outbox SET payload_hash = ${otherHash}
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toThrow(/identity and payload hash are immutable/i);
    await expect(
      db()`
        DELETE FROM budget_usage_ledger
        WHERE builder_id = ${builderId} AND id = ${committed.usageId!}
      `,
    ).rejects.toThrow(/budget_usage_ledger rows cannot be deleted/i);
    await expect(
      db()`
        DELETE FROM budget_cost_event_outbox
        WHERE builder_id = ${builderId} AND id = ${committed.outboxId!}
      `,
    ).rejects.toThrow(/budget_cost_event_outbox rows are immutable and cannot be deleted/i);
  });

  it('deduplicates extension retries and terminal transition retries', async () => {
    const extensionBuilder = await insertBuilder(db(), 'ledger-extension-idempotency');
    const extended = await extendReservation(db(), await seedDecision(db(), extensionBuilder));
    await useBuilder(db(), extensionBuilder);
    await expect(
      db()`
        INSERT INTO budget_reservation_transitions (
          builder_id, id, reservation_decision_id, type, extension_id, release_reason,
          request_hash, request_snapshot, response_snapshot,
          from_state, to_state, from_state_version, to_state_version,
          from_expires_at, to_expires_at, extend_by_seconds, occurred_at
        )
        SELECT builder_id, ${crypto.randomUUID()}, reservation_decision_id, type,
               extension_id, release_reason, request_hash, request_snapshot,
               response_snapshot, from_state, to_state, from_state_version,
               to_state_version, from_expires_at, to_expires_at,
               extend_by_seconds, occurred_at
        FROM budget_reservation_transitions
        WHERE builder_id = ${extensionBuilder} AND id = ${extended.transitionId!}
      `,
    ).rejects.toThrow(/budget_reservation_transitions_idempotency_uk|duplicate key/i);

    const terminalBuilder = await insertBuilder(db(), 'ledger-terminal-idempotency');
    const committed = await commitReservation(db(), await seedDecision(db(), terminalBuilder));
    await useBuilder(db(), terminalBuilder);
    await expect(
      db()`
        INSERT INTO budget_reservation_transitions (
          builder_id, id, reservation_decision_id, type, extension_id, release_reason,
          request_hash, request_snapshot, response_snapshot,
          from_state, to_state, from_state_version, to_state_version,
          from_expires_at, to_expires_at, extend_by_seconds, occurred_at
        )
        SELECT builder_id, ${crypto.randomUUID()}, reservation_decision_id, type,
               extension_id, release_reason, request_hash, request_snapshot,
               response_snapshot, from_state, to_state, from_state_version,
               to_state_version, from_expires_at, to_expires_at,
               extend_by_seconds, occurred_at
        FROM budget_reservation_transitions
        WHERE builder_id = ${terminalBuilder} AND id = ${committed.transitionId!}
      `,
    ).rejects.toThrow(/budget_reservation_transitions.*uk|duplicate key/i);
  });
});
