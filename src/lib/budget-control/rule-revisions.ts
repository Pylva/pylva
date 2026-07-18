import type { Sql, TransactionSql } from 'postgres';
import { withBudgetBuilderTransaction, type BudgetTransactionOptions } from './transaction.js';

export type BudgetRuleScope = 'pooled' | 'per_customer';
export type BudgetRulePeriod = 'hour' | 'day' | 'week' | 'month';
export type BudgetRuleEnforcement = 'hard_stop' | 'advisory';
export type BudgetRuleRetirementReason = 'superseded' | 'disabled' | 'deleted';

export type BudgetRuleRevisionAction =
  | 'not_applicable'
  | 'unchanged'
  | 'created'
  | 'superseded'
  | 'disabled'
  | 'reenabled'
  | 'deleted';

export interface BudgetRuleRevisionResult {
  action: BudgetRuleRevisionAction;
  rule_key: string;
  revision_id: string | null;
  revision: string | null;
}

export interface BudgetRuleRevisionOptions extends Pick<
  BudgetTransactionOptions,
  'maxAttempts' | 'sleep' | 'onRetry'
> {
  client?: Sql;
}

export interface BudgetRuleMutationOutcome<T> {
  kind: 'upsert' | 'delete';
  value: T;
}

export interface BudgetRuleMutationResult<T> {
  value: T;
  revision: BudgetRuleRevisionResult;
}

export type BudgetRuleMutation<T> = (
  transaction: TransactionSql,
) => Promise<BudgetRuleMutationOutcome<T>>;

interface MutableRuleRow {
  id: unknown;
  builder_id: unknown;
  type: unknown;
  enforcement: unknown;
  enabled: unknown;
  status: unknown;
  customer_id: unknown;
  scope: unknown;
  period: unknown;
  ledger_enforcement: unknown;
  limit_usd: unknown;
  config_valid: unknown;
}

interface MutableBudgetRule {
  authoritative: true;
  ruleKey: string;
  eligible: boolean;
  scope: BudgetRuleScope;
  targetCustomerId: string | null;
  period: BudgetRulePeriod;
  enforcement: BudgetRuleEnforcement;
  limitUsd: string;
}

interface NonBudgetRule {
  authoritative: false;
  ruleKey: string;
}

type MutableRule = MutableBudgetRule | NonBudgetRule;

interface RevisionRow {
  id: unknown;
  revision: unknown;
  scope: unknown;
  target_customer_id: unknown;
  period: unknown;
  enforcement: unknown;
  limit_usd: unknown;
  retired_at: unknown;
  retirement_reason: unknown;
}

interface BudgetRuleRevision {
  id: string;
  revision: string;
  scope: BudgetRuleScope;
  targetCustomerId: string | null;
  period: BudgetRulePeriod;
  enforcement: BudgetRuleEnforcement;
  limitUsd: string;
  retiredAt: string | null;
  retirementReason: BudgetRuleRetirementReason | null;
}

interface InsertedRevisionRow {
  id: unknown;
  revision: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/;
const SCOPES = new Set<BudgetRuleScope>(['pooled', 'per_customer']);
const PERIODS = new Set<BudgetRulePeriod>(['hour', 'day', 'week', 'month']);
const ENFORCEMENTS = new Set<BudgetRuleEnforcement>(['hard_stop', 'advisory']);
const RETIREMENT_REASONS = new Set<BudgetRuleRetirementReason>([
  'superseded',
  'disabled',
  'deleted',
]);

export class BudgetRuleConfigurationError extends Error {
  readonly ruleKey: string;

  constructor(ruleKey: string, message = 'budget_limit rule has invalid authoritative config') {
    super(message);
    this.name = 'BudgetRuleConfigurationError';
    this.ruleKey = ruleKey;
  }
}

export class BudgetRuleStructuralChangeError extends Error {
  readonly ruleKey: string;

  constructor(ruleKey: string) {
    super('scope, customer targeting, and period require a new budget rule identity');
    this.name = 'BudgetRuleStructuralChangeError';
    this.ruleKey = ruleKey;
  }
}

export class BudgetRuleTerminalError extends Error {
  readonly ruleKey: string;

  constructor(ruleKey: string) {
    super('a deleted authoritative budget rule cannot be reactivated');
    this.name = 'BudgetRuleTerminalError';
    this.ruleKey = ruleKey;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isScope(value: unknown): value is BudgetRuleScope {
  return typeof value === 'string' && SCOPES.has(value as BudgetRuleScope);
}

function isPeriod(value: unknown): value is BudgetRulePeriod {
  return typeof value === 'string' && PERIODS.has(value as BudgetRulePeriod);
}

function isEnforcement(value: unknown): value is BudgetRuleEnforcement {
  return typeof value === 'string' && ENFORCEMENTS.has(value as BudgetRuleEnforcement);
}

function isRetirementReason(value: unknown): value is BudgetRuleRetirementReason {
  return typeof value === 'string' && RETIREMENT_REASONS.has(value as BudgetRuleRetirementReason);
}

function assertRuleIdentity(builderId: string, ruleKey: string): void {
  if (!isUuid(builderId)) throw new TypeError('builderId must be a UUID');
  if (!isUuid(ruleKey)) throw new TypeError('ruleKey must be a UUID');
}

function parseMutableRule(rows: readonly MutableRuleRow[], builderId: string): MutableRule | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('mutable rule query returned duplicate rule identities');
  const row = rows[0]!;
  if (!isUuid(row.id) || row.builder_id !== builderId.toLowerCase()) {
    throw new Error('mutable rule query returned an invalid tenant identity');
  }
  if (row.type !== 'budget_limit') return { authoritative: false, ruleKey: row.id };
  if (
    row.config_valid !== true ||
    !isScope(row.scope) ||
    !isPeriod(row.period) ||
    !isEnforcement(row.ledger_enforcement) ||
    typeof row.limit_usd !== 'string' ||
    !DECIMAL_PATTERN.test(row.limit_usd) ||
    (row.customer_id !== null && typeof row.customer_id !== 'string')
  ) {
    const invalidFields = [
      row.config_valid !== true ? 'database_validation' : null,
      !isScope(row.scope) ? 'scope' : null,
      !isPeriod(row.period) ? 'period' : null,
      !isEnforcement(row.ledger_enforcement) ? 'enforcement' : null,
      typeof row.limit_usd !== 'string' ? 'limit_type' : null,
      typeof row.limit_usd === 'string' && !DECIMAL_PATTERN.test(row.limit_usd)
        ? 'limit_format'
        : null,
      row.customer_id !== null && typeof row.customer_id !== 'string' ? 'target_type' : null,
    ].filter((field): field is string => field !== null);
    throw new BudgetRuleConfigurationError(
      row.id,
      `budget_limit rule has invalid authoritative config (${invalidFields.join(', ')})`,
    );
  }

  return {
    authoritative: true,
    ruleKey: row.id,
    eligible: row.enforcement === 'pre_call' && row.enabled === true && row.status === 'active',
    scope: row.scope,
    targetCustomerId: row.customer_id,
    period: row.period,
    enforcement: row.ledger_enforcement,
    limitUsd: row.limit_usd,
  };
}

function parseRevisionRows(rows: readonly RevisionRow[]): BudgetRuleRevision | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('rule revision query returned more than one latest row');
  const row = rows[0]!;
  if (
    !isUuid(row.id) ||
    typeof row.revision !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(row.revision) ||
    !isScope(row.scope) ||
    !isPeriod(row.period) ||
    !isEnforcement(row.enforcement) ||
    typeof row.limit_usd !== 'string' ||
    !DECIMAL_PATTERN.test(row.limit_usd) ||
    (row.target_customer_id !== null && typeof row.target_customer_id !== 'string') ||
    (row.retired_at !== null && typeof row.retired_at !== 'string') ||
    (row.retirement_reason !== null && !isRetirementReason(row.retirement_reason)) ||
    (row.retired_at === null) !== (row.retirement_reason === null)
  ) {
    throw new Error('rule revision query returned an invalid lifecycle row');
  }
  return {
    id: row.id,
    revision: row.revision,
    scope: row.scope,
    targetCustomerId: row.target_customer_id,
    period: row.period,
    enforcement: row.enforcement,
    limitUsd: row.limit_usd,
    retiredAt: row.retired_at,
    retirementReason: row.retirement_reason,
  };
}

function parseInsertedRevision(rows: readonly InsertedRevisionRow[]): {
  id: string;
  revision: string;
} {
  if (
    rows.length !== 1 ||
    !isUuid(rows[0]?.id) ||
    typeof rows[0]?.revision !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(rows[0].revision)
  ) {
    throw new Error('rule revision insert did not return one valid revision');
  }
  return { id: rows[0].id, revision: rows[0].revision };
}

async function loadMutableRule(
  transaction: TransactionSql,
  builderId: string,
  ruleKey: string,
): Promise<MutableRule | null> {
  const rows = await transaction<MutableRuleRow[]>`
    WITH raw_rule AS MATERIALIZED (
      SELECT rule.id::TEXT AS id, rule.builder_id::TEXT AS builder_id,
             rule.type, rule.enforcement, rule.enabled, rule.status,
             rule.customer_id, rule.config->>'scope' AS scope,
             rule.config->>'period' AS period,
             CASE WHEN rule.config->>'hard_stop' = 'true'
               THEN 'hard_stop' ELSE 'advisory'
             END AS ledger_enforcement,
             CASE WHEN jsonb_typeof(rule.config->'limit_usd') = 'number'
               THEN (rule.config->>'limit_usd')::NUMERIC
               ELSE NULL
             END AS limit_numeric,
             jsonb_typeof(rule.config->'hard_stop') AS hard_stop_type
      FROM public.rules rule
      WHERE rule.builder_id = ${builderId}::UUID
        AND rule.id = ${ruleKey}::UUID
      FOR UPDATE OF rule
    )
    SELECT id, builder_id, type, enforcement, enabled, status, customer_id,
           scope, period, ledger_enforcement,
           CASE WHEN limit_numeric IS NULL THEN NULL
             ELSE public.pylva_budget_decimal_text(limit_numeric)
           END AS limit_usd,
           (
             type <> 'budget_limit'
             OR (
               scope IN ('pooled', 'per_customer')
               AND period IN ('hour', 'day', 'week', 'month')
               AND hard_stop_type = 'boolean'
               AND limit_numeric IS NOT NULL
               AND limit_numeric >= 0
               AND limit_numeric < 100000000000000000000::NUMERIC
               AND pg_catalog.scale(limit_numeric) <= 18
               AND (
                 (scope = 'pooled' AND customer_id IS NULL)
                 OR (scope = 'per_customer' AND (
                   customer_id IS NULL
                   OR customer_id ~ '^[A-Za-z0-9_-]{1,255}$'
                 ))
               )
             )
           ) AS config_valid
    FROM raw_rule
  `;
  return parseMutableRule(rows, builderId.toLowerCase());
}

async function loadLatestRevision(
  transaction: TransactionSql,
  builderId: string,
  ruleKey: string,
): Promise<BudgetRuleRevision | null> {
  const rows = await transaction<RevisionRow[]>`
    SELECT id::TEXT AS id, revision::TEXT AS revision, scope,
           target_customer_id, period, enforcement,
           public.pylva_budget_decimal_text(limit_usd) AS limit_usd,
           CASE WHEN retired_at IS NULL THEN NULL
             ELSE public.pylva_budget_timestamp_text(retired_at)
           END AS retired_at,
           retirement_reason
    FROM public.budget_rule_revisions
    WHERE builder_id = ${builderId}::UUID AND rule_key = ${ruleKey}::UUID
    ORDER BY revision DESC
    LIMIT 1
    FOR UPDATE
  `;
  return parseRevisionRows(rows);
}

function assertStructureUnchanged(source: MutableBudgetRule, revision: BudgetRuleRevision): void {
  if (
    source.scope !== revision.scope ||
    source.targetCustomerId !== revision.targetCustomerId ||
    source.period !== revision.period
  ) {
    throw new BudgetRuleStructuralChangeError(source.ruleKey);
  }
}

async function retireRevision(
  transaction: TransactionSql,
  builderId: string,
  revisionId: string,
  reason: BudgetRuleRetirementReason,
): Promise<void> {
  const rows = await transaction<{ id: unknown }[]>`
    UPDATE public.budget_rule_revisions
    SET retired_at = pg_catalog.transaction_timestamp(),
        retirement_reason = ${reason}
    WHERE builder_id = ${builderId}::UUID
      AND id = ${revisionId}::UUID
      AND retired_at IS NULL
    RETURNING id::TEXT AS id
  `;
  if (rows.length !== 1 || rows[0]?.id !== revisionId.toLowerCase()) {
    throw new Error('active rule revision changed during the exclusive builder transaction');
  }
}

async function insertRevision(
  transaction: TransactionSql,
  builderId: string,
  source: Pick<
    MutableBudgetRule,
    'ruleKey' | 'scope' | 'targetCustomerId' | 'period' | 'enforcement' | 'limitUsd'
  >,
): Promise<{ id: string; revision: string }> {
  const rows = await transaction<InsertedRevisionRow[]>`
    WITH snapshot AS MATERIALIZED (
      SELECT jsonb_build_object(
        'schema_version', '1.0',
        'rule_key', ${source.ruleKey}::UUID::TEXT,
        'scope', ${source.scope}::TEXT,
        'target_customer_id',
          CASE WHEN ${source.targetCustomerId}::TEXT IS NULL THEN 'null'::JSONB
            ELSE to_jsonb(${source.targetCustomerId}::TEXT)
          END,
        'period', ${source.period}::TEXT,
        'enforcement', ${source.enforcement}::TEXT,
        'limit_usd', public.pylva_budget_decimal_text(${source.limitUsd}::NUMERIC)
      ) AS value
    )
    INSERT INTO public.budget_rule_revisions (
      builder_id, rule_key, revision, scope, target_customer_id, period,
      enforcement, limit_usd, config_snapshot, config_snapshot_hash
    )
    SELECT ${builderId}::UUID, ${source.ruleKey}::UUID, 0, ${source.scope},
           ${source.targetCustomerId}, ${source.period}, ${source.enforcement},
           ${source.limitUsd}::NUMERIC, snapshot.value,
           public.pylva_budget_jsonb_sha256(snapshot.value)
    FROM snapshot
    RETURNING id::TEXT AS id, revision::TEXT AS revision
  `;
  return parseInsertedRevision(rows);
}

/**
 * Reconciles one mutable rule to the immutable authoritative history. The
 * caller must hold the exclusive builder lock and must perform the mutable
 * rule write in this same transaction. That is what makes the two histories
 * atomic instead of eventually consistent.
 */
export async function reconcileBudgetRuleRevisionInTransaction(
  transaction: TransactionSql,
  builderId: string,
  ruleKey: string,
): Promise<BudgetRuleRevisionResult> {
  assertRuleIdentity(builderId, ruleKey);
  const source = await loadMutableRule(transaction, builderId, ruleKey);
  const latest = await loadLatestRevision(transaction, builderId, ruleKey);

  if (source === null) {
    if (latest !== null) {
      throw new BudgetRuleConfigurationError(
        ruleKey,
        'authoritative rule history exists but the mutable rule is missing; use terminal deletion',
      );
    }
    return { action: 'not_applicable', rule_key: ruleKey, revision_id: null, revision: null };
  }

  if (!source.authoritative) {
    if (latest !== null) throw new BudgetRuleStructuralChangeError(ruleKey);
    return { action: 'not_applicable', rule_key: ruleKey, revision_id: null, revision: null };
  }

  if (latest !== null) {
    assertStructureUnchanged(source, latest);
    if (latest.retirementReason === 'deleted') throw new BudgetRuleTerminalError(ruleKey);
  }

  if (!source.eligible) {
    if (latest === null || latest.retiredAt !== null) {
      return {
        action: 'not_applicable',
        rule_key: ruleKey,
        revision_id: latest?.id ?? null,
        revision: latest?.revision ?? null,
      };
    }
    await retireRevision(transaction, builderId, latest.id, 'disabled');
    return {
      action: 'disabled',
      rule_key: ruleKey,
      revision_id: latest.id,
      revision: latest.revision,
    };
  }

  if (latest === null) {
    const inserted = await insertRevision(transaction, builderId, source);
    return {
      action: 'created',
      rule_key: ruleKey,
      revision_id: inserted.id,
      revision: inserted.revision,
    };
  }

  if (latest.retiredAt !== null) {
    if (latest.retirementReason !== 'disabled') {
      throw new Error('latest retired rule revision has no legal re-enable path');
    }
    const inserted = await insertRevision(transaction, builderId, source);
    return {
      action: 'reenabled',
      rule_key: ruleKey,
      revision_id: inserted.id,
      revision: inserted.revision,
    };
  }

  if (latest.enforcement === source.enforcement && latest.limitUsd === source.limitUsd) {
    return {
      action: 'unchanged',
      rule_key: ruleKey,
      revision_id: latest.id,
      revision: latest.revision,
    };
  }

  await retireRevision(transaction, builderId, latest.id, 'superseded');
  const inserted = await insertRevision(transaction, builderId, source);
  return {
    action: 'superseded',
    rule_key: ruleKey,
    revision_id: inserted.id,
    revision: inserted.revision,
  };
}

/**
 * Makes deletion terminal. If a rule was already disabled, it creates and
 * immediately retires the next immutable revision as a terminal tombstone so
 * the migration can reject every future reactivation of that rule identity.
 */
export async function terminalizeBudgetRuleDeletionInTransaction(
  transaction: TransactionSql,
  builderId: string,
  ruleKey: string,
): Promise<BudgetRuleRevisionResult> {
  assertRuleIdentity(builderId, ruleKey);
  const latest = await loadLatestRevision(transaction, builderId, ruleKey);
  if (latest === null) {
    return { action: 'not_applicable', rule_key: ruleKey, revision_id: null, revision: null };
  }
  if (latest.retirementReason === 'deleted') {
    return {
      action: 'deleted',
      rule_key: ruleKey,
      revision_id: latest.id,
      revision: latest.revision,
    };
  }
  if (latest.retiredAt === null) {
    await retireRevision(transaction, builderId, latest.id, 'deleted');
    return {
      action: 'deleted',
      rule_key: ruleKey,
      revision_id: latest.id,
      revision: latest.revision,
    };
  }
  if (latest.retirementReason !== 'disabled') {
    throw new Error('cannot terminalize an incomplete superseded revision chain');
  }

  const tombstone = await insertRevision(transaction, builderId, {
    ruleKey,
    scope: latest.scope,
    targetCustomerId: latest.targetCustomerId,
    period: latest.period,
    enforcement: latest.enforcement,
    limitUsd: latest.limitUsd,
  });
  await retireRevision(transaction, builderId, tombstone.id, 'deleted');
  return {
    action: 'deleted',
    rule_key: ruleKey,
    revision_id: tombstone.id,
    revision: tombstone.revision,
  };
}

/**
 * Atomic integration point for the existing rule repository. The callback may
 * be replayed after a safe PostgreSQL retry, so it must keep all mutations in
 * this transaction and perform no external side effects.
 */
export function withBudgetRuleRevisionMutation<T>(
  builderId: string,
  ruleKey: string,
  mutation: BudgetRuleMutation<T>,
  options: BudgetRuleRevisionOptions = {},
): Promise<BudgetRuleMutationResult<T>> {
  assertRuleIdentity(builderId, ruleKey);
  return withBudgetBuilderTransaction(
    builderId,
    'exclusive',
    async (transaction) => {
      const outcome = await mutation(transaction);
      if (outcome.kind !== 'upsert' && outcome.kind !== 'delete') {
        throw new TypeError('budget rule mutation must declare upsert or delete');
      }
      const revision =
        outcome.kind === 'delete'
          ? await terminalizeBudgetRuleDeletionInTransaction(transaction, builderId, ruleKey)
          : await reconcileBudgetRuleRevisionInTransaction(transaction, builderId, ruleKey);
      return { value: outcome.value, revision };
    },
    options,
  );
}
