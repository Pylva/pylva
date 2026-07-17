import { NUMERIC_38_18_PATTERN } from '@pylva/shared';
import type { Sql, TransactionSql } from 'postgres';
import {
  getBudgetExactBackfillAdapter,
  type BudgetExactBackfillAdapter,
} from './exact-backfill-adapter.js';
import {
  BudgetControlNotReadyError,
  readBudgetControlReadinessInTransaction,
  type BudgetControlCutoverMode,
} from './readiness.js';
import {
  pgCanonicalDecimalText,
  withBudgetBuilderTransaction,
  type BudgetTransactionOptions,
} from './transaction.js';
import type { BudgetRuleEnforcement, BudgetRulePeriod, BudgetRuleScope } from './rule-revisions.js';

export type BudgetAccountOpeningSource = 'post_cutover_zero' | 'exact_backfill';

export interface EnsureBudgetAccountsInput {
  builderId: string;
  customerId: string;
}

export interface ExactOpeningBalanceInput {
  tx: TransactionSql;
  builderId: string;
  ruleKey: string;
  ruleRevisionId: string;
  subjectCustomerId: string | null;
  period: BudgetRulePeriod;
  periodStart: string;
  periodEnd: string;
  measuredThrough: string;
}

/**
 * Must read an already-reconciled authoritative source. It runs under the
 * exclusive builder transaction and must not perform mutable external side
 * effects. Returning a best guess is forbidden.
 */
export type ResolveExactOpeningBalance = (
  input: ExactOpeningBalanceInput,
) => string | Promise<string>;

export interface BudgetAccountMaterializationOptions extends Pick<
  BudgetTransactionOptions,
  'maxAttempts' | 'sleep' | 'onRetry'
> {
  client?: Sql;
  exactBackfillAdapter?: BudgetExactBackfillAdapter;
  resolveExactOpeningBalance?: ResolveExactOpeningBalance;
}

export interface BudgetAccountMaterializationResult {
  builder_id: string;
  customer_id: string;
  existing: number;
  materialized: number;
  account_ids: string[];
}

interface ApplicableRevisionRow {
  id: unknown;
  rule_key: unknown;
  revision: unknown;
  active_from: unknown;
  scope: unknown;
  subject_customer_id: unknown;
  period: unknown;
  period_start: unknown;
  period_end: unknown;
  enforcement: unknown;
  limit_usd: unknown;
  opening_source: unknown;
  account_id: unknown;
  evidence_source: unknown;
  evidence_measured_through: unknown;
}

interface ApplicableRevision {
  id: string;
  ruleKey: string;
  revision: string;
  activeFrom: string;
  scope: BudgetRuleScope;
  subjectCustomerId: string | null;
  period: BudgetRulePeriod;
  periodStart: string;
  periodEnd: string;
  enforcement: BudgetRuleEnforcement;
  limitUsd: string;
  openingSource: BudgetAccountOpeningSource | 'unavailable';
  accountId: string | null;
  evidenceSource: BudgetAccountOpeningSource | null;
  evidenceMeasuredThrough: string | null;
}

interface InsertedAccountRow {
  account_id: unknown;
  source: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const CANONICAL_TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const MAX_REVISION = 9_223_372_036_854_775_806n;
const SCOPES = new Set<BudgetRuleScope>(['pooled', 'per_customer']);
const PERIODS = new Set<BudgetRulePeriod>(['hour', 'day', 'week', 'month']);
const ENFORCEMENTS = new Set<BudgetRuleEnforcement>(['hard_stop', 'advisory']);
const OPENING_SOURCES = new Set<BudgetAccountOpeningSource>([
  'post_cutover_zero',
  'exact_backfill',
]);

export class BudgetExactOpeningBalanceUnavailableError extends Error {
  readonly ruleKey: string;

  constructor(ruleKey: string) {
    super('exact reconciled opening balance is required for this current-period account');
    this.name = 'BudgetExactOpeningBalanceUnavailableError';
    this.ruleKey = ruleKey;
  }
}

export class BudgetAccountPeriodNotEligibleError extends Error {
  readonly ruleKey: string;

  constructor(ruleKey: string) {
    super('budget account period is not safely eligible at the builder cutover');
    this.name = 'BudgetAccountPeriodNotEligibleError';
    this.ruleKey = ruleKey;
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validateInput(input: EnsureBudgetAccountsInput): void {
  if (!isUuid(input.builderId)) throw new TypeError('builderId must be a UUID');
  if (!CUSTOMER_ID_PATTERN.test(input.customerId)) {
    throw new TypeError('customerId must contain 1-255 URL-safe identifier characters');
  }
}

function parseApplicableRevisions(
  rows: readonly ApplicableRevisionRow[],
  customerId: string,
  cutoverAt: string,
): ApplicableRevision[] {
  const revisions = rows.map((row) => {
    const revisionIsValid =
      typeof row.revision === 'string' &&
      /^(?:0|[1-9][0-9]*)$/.test(row.revision) &&
      BigInt(row.revision) <= MAX_REVISION;
    if (
      !isUuid(row.id) ||
      !isUuid(row.rule_key) ||
      !revisionIsValid ||
      typeof row.active_from !== 'string' ||
      !CANONICAL_TIMESTAMP_PATTERN.test(row.active_from) ||
      !SCOPES.has(row.scope as BudgetRuleScope) ||
      (row.subject_customer_id !== null && typeof row.subject_customer_id !== 'string') ||
      !PERIODS.has(row.period as BudgetRulePeriod) ||
      typeof row.period_start !== 'string' ||
      !CANONICAL_TIMESTAMP_PATTERN.test(row.period_start) ||
      typeof row.period_end !== 'string' ||
      !CANONICAL_TIMESTAMP_PATTERN.test(row.period_end) ||
      row.period_start >= row.period_end ||
      !ENFORCEMENTS.has(row.enforcement as BudgetRuleEnforcement) ||
      typeof row.limit_usd !== 'string' ||
      !NUMERIC_38_18_PATTERN.test(row.limit_usd) ||
      (row.opening_source !== 'unavailable' &&
        !OPENING_SOURCES.has(row.opening_source as BudgetAccountOpeningSource)) ||
      (row.account_id !== null && !isUuid(row.account_id)) ||
      (row.evidence_source !== null &&
        !OPENING_SOURCES.has(row.evidence_source as BudgetAccountOpeningSource)) ||
      (row.evidence_measured_through !== null &&
        (typeof row.evidence_measured_through !== 'string' ||
          !CANONICAL_TIMESTAMP_PATTERN.test(row.evidence_measured_through)))
    ) {
      throw new Error('account materialization query returned an invalid applicable revision');
    }
    if (row.scope === 'pooled' && row.subject_customer_id !== null) {
      throw new Error('pooled materialization row unexpectedly has a customer subject');
    }
    if (row.scope === 'per_customer' && row.subject_customer_id === null) {
      throw new Error('per-customer materialization row is missing its customer subject');
    }
    if (row.scope === 'per_customer' && row.subject_customer_id !== customerId) {
      throw new Error('per-customer materialization row has the wrong customer subject');
    }
    if (
      row.account_id === null &&
      (row.evidence_source !== null || row.evidence_measured_through !== null)
    ) {
      throw new Error('opening evidence cannot exist without its budget account');
    }
    if (
      row.account_id !== null &&
      (row.evidence_source === null || row.evidence_measured_through !== cutoverAt)
    ) {
      throw new Error('existing authoritative budget account has incomplete opening evidence');
    }
    return {
      id: row.id,
      ruleKey: row.rule_key,
      revision: row.revision as string,
      activeFrom: row.active_from,
      scope: row.scope as BudgetRuleScope,
      subjectCustomerId: row.subject_customer_id,
      period: row.period as BudgetRulePeriod,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      enforcement: row.enforcement as BudgetRuleEnforcement,
      limitUsd: row.limit_usd,
      openingSource: row.opening_source as BudgetAccountOpeningSource | 'unavailable',
      accountId: row.account_id,
      evidenceSource: row.evidence_source as BudgetAccountOpeningSource | null,
      evidenceMeasuredThrough: row.evidence_measured_through,
    };
  });

  const ruleKeys = new Set<string>();
  const accountIds = new Set<string>();
  for (const revision of revisions) {
    if (ruleKeys.has(revision.ruleKey)) {
      throw new Error('account materialization query returned duplicate active rule identities');
    }
    ruleKeys.add(revision.ruleKey);
    if (revision.accountId !== null) {
      if (accountIds.has(revision.accountId)) {
        throw new Error('account materialization query returned duplicate account identities');
      }
      accountIds.add(revision.accountId);
    }
  }
  return revisions;
}

async function loadApplicableAccounts(
  transaction: TransactionSql,
  builderId: string,
  customerId: string,
  cutoverMode: BudgetControlCutoverMode,
  cutoverAt: string,
  readyOrder: string,
): Promise<ApplicableRevision[]> {
  const rows = await transaction<ApplicableRevisionRow[]>`
    WITH server_clock AS MATERIALIZED (
      SELECT date_trunc('milliseconds', pg_catalog.clock_timestamp()) AS value
    ),
    revision_periods AS MATERIALIZED (
      SELECT revision.id, revision.rule_key, revision.revision,
             revision.active_from,
             origin.authority_order AS rule_origin_authority_order,
             revision.scope,
             CASE WHEN revision.scope = 'pooled' THEN NULL
               ELSE ${customerId}::TEXT
             END AS subject_customer_id,
             revision.period, revision.enforcement, revision.limit_usd,
             CASE revision.period
               WHEN 'hour' THEN
                 date_trunc('hour', server_clock.value AT TIME ZONE 'UTC')
                   AT TIME ZONE 'UTC'
               WHEN 'day' THEN
                 date_trunc('day', server_clock.value AT TIME ZONE 'UTC')
                   AT TIME ZONE 'UTC'
               WHEN 'week' THEN
                 date_trunc('week', server_clock.value AT TIME ZONE 'UTC')
                   AT TIME ZONE 'UTC'
               WHEN 'month' THEN
                 date_trunc('month', server_clock.value AT TIME ZONE 'UTC')
                   AT TIME ZONE 'UTC'
             END AS period_start
      FROM public.budget_rule_revisions revision
      JOIN public.budget_rule_revisions origin
        ON origin.builder_id = revision.builder_id
       AND origin.rule_key = revision.rule_key
       AND origin.revision = 0
      CROSS JOIN server_clock
      WHERE revision.builder_id = ${builderId}::UUID
        AND revision.retired_at IS NULL
        AND (
          revision.target_customer_id IS NULL
          OR revision.target_customer_id = ${customerId}
        )
    ),
    bounded AS MATERIALIZED (
      SELECT revision_periods.*,
             CASE period
               WHEN 'hour' THEN period_start + INTERVAL '1 hour'
               WHEN 'day' THEN period_start + INTERVAL '1 day'
               WHEN 'week' THEN period_start + INTERVAL '7 days'
               WHEN 'month' THEN (
                 (period_start AT TIME ZONE 'UTC') + INTERVAL '1 month'
               ) AT TIME ZONE 'UTC'
             END AS period_end
      FROM revision_periods
    )
    SELECT bounded.id::TEXT AS id, bounded.rule_key::TEXT AS rule_key,
           bounded.revision::TEXT AS revision,
           public.pylva_budget_timestamp_text(bounded.active_from) AS active_from,
           bounded.scope, bounded.subject_customer_id, bounded.period,
           public.pylva_budget_timestamp_text(bounded.period_start) AS period_start,
           public.pylva_budget_timestamp_text(bounded.period_end) AS period_end,
           bounded.enforcement,
           public.pylva_budget_decimal_text(bounded.limit_usd) AS limit_usd,
           CASE
             WHEN bounded.period_start >= ${cutoverAt}::TIMESTAMPTZ
               OR (
                 bounded.rule_origin_authority_order > ${readyOrder}::BIGINT
               )
               THEN 'post_cutover_zero'
             WHEN ${cutoverMode} = 'exact_backfill'
               AND bounded.period_start < ${cutoverAt}::TIMESTAMPTZ
               AND bounded.period_end > ${cutoverAt}::TIMESTAMPTZ
               THEN 'exact_backfill'
             ELSE 'unavailable'
           END AS opening_source,
           account.id::TEXT AS account_id,
           evidence.source AS evidence_source,
           CASE WHEN evidence.measured_through IS NULL THEN NULL
             ELSE public.pylva_budget_timestamp_text(evidence.measured_through)
           END AS evidence_measured_through
    FROM bounded
    LEFT JOIN public.budget_accounts account
      ON account.builder_id = ${builderId}::UUID
     AND account.rule_key = bounded.rule_key
     AND account.scope = bounded.scope
     AND account.subject_customer_id IS NOT DISTINCT FROM bounded.subject_customer_id
     AND account.period = bounded.period
     AND account.period_start = bounded.period_start
    LEFT JOIN public.budget_account_opening_evidence evidence
      ON evidence.builder_id = account.builder_id AND evidence.account_id = account.id
    ORDER BY bounded.rule_key, bounded.id
  `;
  return parseApplicableRevisions(rows, customerId, cutoverAt);
}

async function canonicalOpeningBalance(
  transaction: TransactionSql,
  rawValue: string,
): Promise<string> {
  const canonical = await pgCanonicalDecimalText(transaction, rawValue);
  if (!NUMERIC_38_18_PATTERN.test(canonical)) {
    throw new RangeError('opening committed amount must fit nonnegative NUMERIC(38,18)');
  }
  return canonical;
}

async function insertAccountAndEvidence(
  transaction: TransactionSql,
  builderId: string,
  revision: ApplicableRevision,
  source: BudgetAccountOpeningSource,
  openingUsd: string,
  cutoverAt: string,
): Promise<string> {
  const rows = await transaction<InsertedAccountRow[]>`
    WITH input AS MATERIALIZED (
      SELECT ${builderId}::UUID AS builder_id,
             ${revision.id}::UUID AS rule_revision_id,
             ${revision.ruleKey}::UUID AS rule_key,
             ${revision.scope}::TEXT AS scope,
             ${revision.subjectCustomerId}::TEXT AS subject_customer_id,
             ${revision.period}::TEXT AS period,
             ${revision.periodStart}::TIMESTAMPTZ AS period_start,
             ${revision.periodEnd}::TIMESTAMPTZ AS period_end,
             ${revision.enforcement}::TEXT AS enforcement,
             ${revision.limitUsd}::NUMERIC(38,18) AS limit_usd,
             ${source}::TEXT AS source,
             ${openingUsd}::NUMERIC(38,18) AS opening_committed_usd,
             ${cutoverAt}::TIMESTAMPTZ AS cutover_at
    ),
    account_snapshot AS MATERIALIZED (
      SELECT input.*,
             jsonb_build_object(
               'schema_version', '1.0',
               'rule_key', input.rule_key::TEXT,
               'scope', input.scope,
               'subject_customer_id',
                 CASE WHEN input.subject_customer_id IS NULL THEN 'null'::JSONB
                   ELSE to_jsonb(input.subject_customer_id)
                 END,
               'period', input.period,
               'period_start', public.pylva_budget_timestamp_text(input.period_start),
               'period_end', public.pylva_budget_timestamp_text(input.period_end),
               'enforcement', input.enforcement,
               'limit_usd', public.pylva_budget_decimal_text(input.limit_usd),
               'opening_committed_usd',
                 public.pylva_budget_decimal_text(input.opening_committed_usd)
             ) AS value
      FROM input
    ),
    inserted_account AS MATERIALIZED (
      INSERT INTO public.budget_accounts (
        builder_id, rule_key, enforcement, limit_usd, scope,
        subject_customer_id, period, period_start, period_end,
        initial_rule_revision_id, initial_rule_snapshot,
        initial_rule_snapshot_hash, opening_committed_usd, committed_usd,
        reserved_usd, unresolved_usd
      )
      SELECT builder_id, rule_key, enforcement, limit_usd, scope,
             subject_customer_id, period, period_start, period_end,
             rule_revision_id, value,
             public.pylva_budget_jsonb_sha256(value), opening_committed_usd,
             opening_committed_usd, 0, 0
      FROM account_snapshot
      RETURNING *
    ),
    evidence_snapshot AS MATERIALIZED (
      SELECT inserted_account.builder_id, inserted_account.id AS account_id,
             account_snapshot.source, account_snapshot.cutover_at,
             inserted_account.opening_committed_usd,
             jsonb_build_object(
               'schema_version', '1.0',
               'source', account_snapshot.source,
               'builder_id', inserted_account.builder_id::TEXT,
               'account_id', inserted_account.id::TEXT,
               'rule_key', inserted_account.rule_key::TEXT,
               'scope', inserted_account.scope,
               'subject_customer_id',
                 CASE WHEN inserted_account.subject_customer_id IS NULL
                   THEN 'null'::JSONB
                   ELSE to_jsonb(inserted_account.subject_customer_id)
                 END,
               'period', inserted_account.period,
               'period_start',
                 public.pylva_budget_timestamp_text(inserted_account.period_start),
               'period_end',
                 public.pylva_budget_timestamp_text(inserted_account.period_end),
               'cutover_at', public.pylva_budget_timestamp_text(account_snapshot.cutover_at),
               'measured_through',
                 public.pylva_budget_timestamp_text(account_snapshot.cutover_at),
               'opening_committed_usd',
                 public.pylva_budget_decimal_text(inserted_account.opening_committed_usd)
             ) AS value
      FROM inserted_account
      JOIN account_snapshot ON TRUE
    ),
    inserted_evidence AS (
      INSERT INTO public.budget_account_opening_evidence (
        builder_id, account_id, source, opening_committed_usd,
        measured_through, evidence_snapshot, evidence_snapshot_hash
      )
      SELECT builder_id, account_id, source, opening_committed_usd,
             cutover_at, value, public.pylva_budget_jsonb_sha256(value)
      FROM evidence_snapshot
      RETURNING account_id, source
    )
    SELECT account_id::TEXT AS account_id, source
    FROM inserted_evidence
  `;
  if (rows.length !== 1 || !isUuid(rows[0]?.account_id) || rows[0]?.source !== source) {
    throw new Error('account materialization did not return one matching evidence row');
  }
  return rows[0].account_id;
}

async function missingOpeningBalance(input: ExactOpeningBalanceInput): Promise<string> {
  throw new BudgetExactOpeningBalanceUnavailableError(input.ruleKey);
}

/**
 * Creates all currently applicable pooled/per-customer accounts in one narrow,
 * separate exclusive-lock transaction. Existing stable accounts are retained
 * across limit/enforcement revision rotations.
 */
export async function ensureBudgetAccountsMaterialized(
  input: EnsureBudgetAccountsInput,
  options: BudgetAccountMaterializationOptions = {},
): Promise<BudgetAccountMaterializationResult> {
  validateInput(input);
  let resolveExactOpeningBalance = options.resolveExactOpeningBalance;
  if (!resolveExactOpeningBalance) {
    const adapter = options.exactBackfillAdapter ?? getBudgetExactBackfillAdapter();
    resolveExactOpeningBalance = adapter
      ? (openingInput) => adapter.resolveOpening(openingInput)
      : missingOpeningBalance;
  }

  return withBudgetBuilderTransaction(
    input.builderId,
    'exclusive',
    async (transaction) => {
      const readiness = await readBudgetControlReadinessInTransaction(transaction, input.builderId);
      if (!readiness.ready) throw new BudgetControlNotReadyError(readiness);

      const revisions = await loadApplicableAccounts(
        transaction,
        input.builderId,
        input.customerId,
        readiness.mode,
        readiness.cutover_at,
        readiness.ready_order,
      );
      const accountIds: string[] = [];
      let existing = 0;

      for (const revision of revisions) {
        if (revision.accountId !== null) {
          existing += 1;
          accountIds.push(revision.accountId);
          continue;
        }
        if (revision.openingSource === 'unavailable') {
          throw new BudgetAccountPeriodNotEligibleError(revision.ruleKey);
        }

        let openingUsd = '0';
        if (revision.openingSource === 'exact_backfill') {
          const rawOpening = await resolveExactOpeningBalance({
            tx: transaction,
            builderId: input.builderId,
            ruleKey: revision.ruleKey,
            ruleRevisionId: revision.id,
            subjectCustomerId: revision.subjectCustomerId,
            period: revision.period,
            periodStart: revision.periodStart,
            periodEnd: revision.periodEnd,
            measuredThrough: readiness.cutover_at,
          });
          if (typeof rawOpening !== 'string') {
            throw new TypeError('exact opening-balance resolver must return a decimal string');
          }
          openingUsd = await canonicalOpeningBalance(transaction, rawOpening);
        }

        accountIds.push(
          await insertAccountAndEvidence(
            transaction,
            input.builderId,
            revision,
            revision.openingSource,
            openingUsd,
            readiness.cutover_at,
          ),
        );
      }

      return {
        builder_id: input.builderId.toLowerCase(),
        customer_id: input.customerId,
        existing,
        materialized: accountIds.length - existing,
        account_ids: accountIds,
      };
    },
    options,
  );
}

/** Reservation-service-shaped adapter with dependencies fixed at construction. */
export function createBudgetAccountMaterializer(
  options: BudgetAccountMaterializationOptions = {},
): (input: EnsureBudgetAccountsInput) => Promise<void> {
  return async (input) => {
    await ensureBudgetAccountsMaterialized(input, options);
  };
}
