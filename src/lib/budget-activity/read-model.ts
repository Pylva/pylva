import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import {
  withBudgetControlReadTransaction,
  type BudgetControlReadTransaction,
} from '../budget-control/read-transaction.js';
import { unwrapRows } from '../db/query-utils.js';
import type {
  BudgetAccountState,
  BudgetAccountStateScope,
  BudgetActivity,
  BudgetActivityAllocation,
  BudgetActivityPage,
  BudgetActivityQuery,
  BudgetActivityStatus,
  ProviderRequestState,
} from './types.js';

interface CountRow {
  total: string | number;
}

interface ActivityRow {
  decision_id: string;
  reservation_id: string | null;
  operation_id: string;
  status: unknown;
  activity_at: string;
  customer_id: string;
  kind: unknown;
  source: string;
  provider: string | null;
  model: string | null;
  cost_source_slug: string | null;
  tool_name: string | null;
  metric: string | null;
  maximum_value: string | null;
  step_name: string | null;
  framework: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  requested_usd: string | null;
  reserved_usd: string;
  actual_usd: string;
  released_usd: string;
  overage_usd: string;
  remaining_usd: string | null;
  reason: string;
  provider_request: unknown;
  cost_event_id: string | null;
  allocations: unknown;
}

interface AccountStateRow extends Omit<BudgetAccountState, 'is_current'> {
  is_current: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const ACTIVITY_STATUS_SET = new Set<BudgetActivityStatus>([
  'reserved',
  'charged',
  'released',
  'unresolved',
  'refused',
]);
const PROVIDER_REQUEST_SET = new Set<ProviderRequestState>(['not_sent', 'sent', 'not_confirmed']);

const activityStatusSql = drizzleSql`
  CASE
    WHEN reservation.decision = 'denied' THEN 'refused'
    WHEN reservation.state = 'committed' THEN 'charged'
    WHEN reservation.state = 'reserved' THEN 'reserved'
    WHEN reservation.state = 'released' THEN 'released'
    WHEN reservation.state = 'unresolved' THEN 'unresolved'
    ELSE NULL
  END
`;

const activityAtSql = drizzleSql`
  CASE
    WHEN reservation.decision = 'denied' THEN reservation.refused_at
    WHEN reservation.state = 'committed' THEN reservation.committed_at
    WHEN reservation.state = 'released' THEN reservation.released_at
    WHEN reservation.state = 'unresolved' THEN reservation.unresolved_at
    ELSE reservation.reserved_at
  END
`;

function assertBuilderId(builderId: string): void {
  if (!UUID_PATTERN.test(builderId)) throw new TypeError('builderId must be a UUID');
}

function activityConditions(builderId: string, query: BudgetActivityQuery): SQL[] {
  const conditions: SQL[] = [
    drizzleSql`reservation.builder_id = ${builderId}::UUID`,
    drizzleSql`(
      reservation.decision = 'denied'
      OR (reservation.decision = 'reserved'
        AND reservation.state IN ('reserved', 'committed', 'released', 'unresolved'))
    )`,
  ];
  if (query.status !== 'all') {
    conditions.push(drizzleSql`${activityStatusSql} = ${query.status}`);
  }
  if (query.kind !== 'all') conditions.push(drizzleSql`reservation.kind = ${query.kind}`);
  if (query.customer !== null) {
    conditions.push(drizzleSql`reservation.customer_id = ${query.customer}`);
  }
  if (query.source !== null) {
    conditions.push(drizzleSql`(
      POSITION(LOWER(${query.source}) IN LOWER(COALESCE(reservation.provider, ''))) > 0
      OR POSITION(LOWER(${query.source}) IN LOWER(COALESCE(reservation.model, ''))) > 0
      OR POSITION(LOWER(${query.source}) IN LOWER(COALESCE(reservation.cost_source_slug, ''))) > 0
      OR POSITION(LOWER(${query.source}) IN LOWER(COALESCE(reservation.tool_name, ''))) > 0
    )`);
  }
  if (query.trace_id !== null) {
    conditions.push(drizzleSql`reservation.trace_id = ${query.trace_id}::UUID`);
  }
  if (query.rule_key !== null) {
    conditions.push(drizzleSql`EXISTS (
      SELECT 1
      FROM public.budget_reservation_allocations rule_filter
      WHERE rule_filter.builder_id = reservation.builder_id
        AND rule_filter.reservation_decision_id = reservation.decision_id
        AND rule_filter.rule_key = ${query.rule_key}::UUID
    )`);
  }
  return conditions;
}

function validDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value);
}

function nullableDecimal(value: unknown): value is string | null {
  return value === null || validDecimal(value);
}

function parseAllocation(value: unknown): BudgetActivityAllocation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('budget activity allocation is not an object');
  }
  const row = value as Record<string, unknown>;
  const decimalFields = [
    'committed_before_usd',
    'reserved_before_usd',
    'unresolved_before_usd',
    'requested_usd',
    'projected_usd',
    'limit_usd',
    'remaining_usd',
    'current_committed_usd',
    'current_reserved_usd',
    'current_unresolved_usd',
  ] as const;
  if (
    !UUID_PATTERN.test(String(row.account_id)) ||
    !UUID_PATTERN.test(String(row.rule_key)) ||
    !UUID_PATTERN.test(String(row.rule_revision_id)) ||
    typeof row.rule_revision !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(row.rule_revision) ||
    (row.scope !== 'pooled' && row.scope !== 'per_customer') ||
    !['hour', 'day', 'week', 'month'].includes(String(row.period)) ||
    (row.enforcement !== 'hard_stop' && row.enforcement !== 'advisory') ||
    !['reserved', 'refused', 'not_held', 'shadow', 'committed', 'released', 'unresolved'].includes(
      String(row.status),
    ) ||
    !Number.isSafeInteger(row.evaluation_order) ||
    typeof row.is_deciding !== 'boolean' ||
    decimalFields.some((field) => !validDecimal(row[field]))
  ) {
    throw new Error('budget activity allocation has an invalid authoritative shape');
  }
  return row as unknown as BudgetActivityAllocation;
}

export function parseBudgetActivityRow(row: ActivityRow): BudgetActivity {
  if (
    typeof row.status !== 'string' ||
    !ACTIVITY_STATUS_SET.has(row.status as BudgetActivityStatus) ||
    (row.kind !== 'llm' && row.kind !== 'tool') ||
    typeof row.provider_request !== 'string' ||
    !PROVIDER_REQUEST_SET.has(row.provider_request as ProviderRequestState) ||
    !nullableDecimal(row.maximum_value) ||
    !nullableDecimal(row.requested_usd) ||
    !validDecimal(row.reserved_usd) ||
    !validDecimal(row.actual_usd) ||
    !validDecimal(row.released_usd) ||
    !validDecimal(row.overage_usd) ||
    !nullableDecimal(row.remaining_usd) ||
    !Array.isArray(row.allocations)
  ) {
    throw new Error('budget activity row has an invalid authoritative shape');
  }
  return {
    ...row,
    status: row.status as BudgetActivityStatus,
    kind: row.kind,
    provider_request: row.provider_request as ProviderRequestState,
    allocations: row.allocations.map(parseAllocation),
  };
}

export async function listBudgetActivityInTransaction(
  transaction: BudgetControlReadTransaction,
  builderId: string,
  query: BudgetActivityQuery,
): Promise<BudgetActivityPage> {
  assertBuilderId(builderId);
  const whereSql = drizzleSql.join(activityConditions(builderId, query), drizzleSql` AND `);
  const offset = (query.page - 1) * query.page_size;

  const countResult = await transaction.execute(drizzleSql`
      SELECT COUNT(*)::TEXT AS total
      FROM public.budget_reservations reservation
      WHERE ${whereSql}
    `);
  const totalRaw = unwrapRows<CountRow>(countResult)[0]?.total ?? '0';
  const total = Number(totalRaw);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error('budget activity count is outside the supported dashboard range');
  }

  const rowsResult = await transaction.execute(drizzleSql`
      SELECT
        reservation.decision_id::TEXT AS decision_id,
        reservation.reservation_id::TEXT AS reservation_id,
        reservation.operation_id::TEXT AS operation_id,
        ${activityStatusSql} AS status,
        public.pylva_budget_timestamp_text(${activityAtSql}) AS activity_at,
        reservation.customer_id,
        reservation.kind,
        CASE reservation.kind
          WHEN 'llm' THEN CONCAT(reservation.provider, ' / ', reservation.model)
          ELSE CONCAT(reservation.cost_source_slug, ' / ', reservation.tool_name)
        END AS source,
        reservation.provider,
        reservation.model,
        reservation.cost_source_slug,
        reservation.tool_name,
        reservation.metric,
        CASE WHEN reservation.maximum_value IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(reservation.maximum_value)
        END AS maximum_value,
        reservation.step_name,
        reservation.framework,
        reservation.trace_id::TEXT AS trace_id,
        reservation.span_id::TEXT AS span_id,
        reservation.parent_span_id::TEXT AS parent_span_id,
        CASE WHEN reservation.requested_usd IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(reservation.requested_usd)
        END AS requested_usd,
        public.pylva_budget_decimal_text(reservation.reserved_usd) AS reserved_usd,
        public.pylva_budget_decimal_text(reservation.actual_usd) AS actual_usd,
        public.pylva_budget_decimal_text(reservation.released_usd) AS released_usd,
        public.pylva_budget_decimal_text(reservation.overage_usd) AS overage_usd,
        CASE WHEN reservation.remaining_usd IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(reservation.remaining_usd)
        END AS remaining_usd,
        COALESCE(
          reservation.decision_reason,
          reservation.unresolved_reason,
          release_transition.release_reason,
          CASE ${activityStatusSql}
            WHEN 'charged' THEN 'provider usage charged'
            WHEN 'reserved' THEN 'authorization held before provider dispatch'
            ELSE 'budget lifecycle action'
          END
        ) AS reason,
        CASE
          WHEN reservation.decision = 'denied' THEN 'not_sent'
          WHEN ${activityStatusSql} = 'charged' THEN 'sent'
          WHEN ${activityStatusSql} = 'released'
            AND release_transition.release_reason = 'provider_not_called' THEN 'not_sent'
          WHEN ${activityStatusSql} = 'released'
            AND release_transition.release_reason = 'provider_confirmed_uncharged' THEN 'sent'
          ELSE 'not_confirmed'
        END AS provider_request,
        usage.cost_event_id::TEXT AS cost_event_id,
        COALESCE(allocation_rows.items, '[]'::JSONB) AS allocations
      FROM public.budget_reservations reservation
      LEFT JOIN public.budget_usage_ledger usage
        ON usage.builder_id = reservation.builder_id
       AND usage.reservation_decision_id = reservation.decision_id
      LEFT JOIN LATERAL (
        SELECT transition.release_reason
        FROM public.budget_reservation_transitions transition
        WHERE transition.builder_id = reservation.builder_id
          AND transition.reservation_decision_id = reservation.decision_id
          AND transition.type = 'release'
        ORDER BY transition.occurred_at DESC, transition.id DESC
        LIMIT 1
      ) release_transition ON TRUE
      LEFT JOIN LATERAL (
        SELECT JSONB_AGG(
          JSONB_BUILD_OBJECT(
            'account_id', allocation.account_id::TEXT,
            'rule_key', allocation.rule_key::TEXT,
            'rule_name', mutable_rule.name,
            'rule_revision_id', allocation.rule_revision_id::TEXT,
            'rule_revision', revision.revision::TEXT,
            'scope', account.scope,
            'subject_customer_id', account.subject_customer_id,
            'period', account.period,
            'period_start', public.pylva_budget_timestamp_text(account.period_start),
            'period_end', public.pylva_budget_timestamp_text(account.period_end),
            'enforcement', allocation.enforcement,
            'status', allocation.status,
            'evaluation_order', allocation.evaluation_order,
            'is_deciding', allocation.is_deciding,
            'committed_before_usd', public.pylva_budget_decimal_text(allocation.committed_before_usd),
            'reserved_before_usd', public.pylva_budget_decimal_text(allocation.reserved_before_usd),
            'unresolved_before_usd', public.pylva_budget_decimal_text(allocation.unresolved_before_usd),
            'requested_usd', public.pylva_budget_decimal_text(allocation.requested_usd),
            'projected_usd', public.pylva_budget_decimal_text(allocation.projected_usd),
            'limit_usd', public.pylva_budget_decimal_text(allocation.limit_usd),
            'remaining_usd', public.pylva_budget_decimal_text(allocation.remaining_usd),
            'current_committed_usd', public.pylva_budget_decimal_text(account.committed_usd),
            'current_reserved_usd', public.pylva_budget_decimal_text(account.reserved_usd),
            'current_unresolved_usd', public.pylva_budget_decimal_text(account.unresolved_usd)
          ) ORDER BY allocation.evaluation_order ASC, allocation.id ASC
        ) AS items
        FROM public.budget_reservation_allocations allocation
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id
         AND account.id = allocation.account_id
        JOIN public.budget_rule_revisions revision
          ON revision.builder_id = allocation.builder_id
         AND revision.id = allocation.rule_revision_id
        LEFT JOIN public.rules mutable_rule
          ON mutable_rule.builder_id = allocation.builder_id
         AND mutable_rule.id = allocation.rule_key
        WHERE allocation.builder_id = reservation.builder_id
          AND allocation.reservation_decision_id = reservation.decision_id
      ) allocation_rows ON TRUE
      WHERE ${whereSql}
      ORDER BY ${activityAtSql} DESC, reservation.decision_id DESC
      LIMIT ${query.page_size}
      OFFSET ${offset}
    `);

  return {
    activities: unwrapRows<ActivityRow>(rowsResult).map(parseBudgetActivityRow),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: total === 0 ? 0 : Math.ceil(total / query.page_size),
    },
    filters: query,
    authority: 'postgresql',
  };
}

export async function listBudgetActivity(
  builderId: string,
  query: BudgetActivityQuery,
): Promise<BudgetActivityPage> {
  return withBudgetControlReadTransaction(builderId, (transaction) =>
    listBudgetActivityInTransaction(transaction, builderId, query),
  );
}

function stateConditions(builderId: string, scope: BudgetAccountStateScope): SQL[] {
  const conditions: SQL[] = [drizzleSql`account.builder_id = ${builderId}::UUID`];
  if (scope.rule_key !== undefined) {
    if (!UUID_PATTERN.test(scope.rule_key)) throw new TypeError('rule_key must be a UUID');
    conditions.push(drizzleSql`account.rule_key = ${scope.rule_key}::UUID`);
  }
  if (scope.customer_id !== undefined) {
    conditions.push(drizzleSql`(
      account.subject_customer_id = ${scope.customer_id}
      OR EXISTS (
        SELECT 1
        FROM public.budget_reservation_allocations customer_allocation
        JOIN public.budget_reservations customer_reservation
          ON customer_reservation.builder_id = customer_allocation.builder_id
         AND customer_reservation.decision_id = customer_allocation.reservation_decision_id
        WHERE customer_allocation.builder_id = account.builder_id
          AND customer_allocation.account_id = account.id
          AND customer_reservation.customer_id = ${scope.customer_id}
      )
    )`);
  }
  if (scope.trace_id !== undefined) {
    if (!UUID_PATTERN.test(scope.trace_id)) throw new TypeError('trace_id must be a UUID');
    conditions.push(drizzleSql`EXISTS (
      SELECT 1
      FROM public.budget_reservation_allocations trace_allocation
      JOIN public.budget_reservations trace_reservation
        ON trace_reservation.builder_id = trace_allocation.builder_id
       AND trace_reservation.decision_id = trace_allocation.reservation_decision_id
      WHERE trace_allocation.builder_id = account.builder_id
        AND trace_allocation.account_id = account.id
        AND trace_reservation.trace_id = ${scope.trace_id}::UUID
    )`);
  }
  return conditions;
}

function validateBudgetAccountStateScope(
  builderId: string,
  scope: BudgetAccountStateScope,
): number {
  assertBuilderId(builderId);
  if (
    scope.customer_id === undefined &&
    scope.trace_id === undefined &&
    scope.rule_key === undefined
  ) {
    throw new TypeError('budget account state requires customer_id, trace_id, or rule_key');
  }
  if (scope.trace_id !== undefined && !UUID_PATTERN.test(scope.trace_id)) {
    throw new TypeError('trace_id must be a UUID');
  }
  if (scope.rule_key !== undefined && !UUID_PATTERN.test(scope.rule_key)) {
    throw new TypeError('rule_key must be a UUID');
  }
  const limit = scope.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('budget account state limit must be between 1 and 50');
  }
  return limit;
}

export async function getBudgetAccountStateInTransaction(
  transaction: BudgetControlReadTransaction,
  builderId: string,
  scope: BudgetAccountStateScope,
): Promise<BudgetAccountState[]> {
  const limit = validateBudgetAccountStateScope(builderId, scope);
  const whereSql = drizzleSql.join(stateConditions(builderId, scope), drizzleSql` AND `);

  const result = await transaction.execute(drizzleSql`
      SELECT
        account.id::TEXT AS account_id,
        account.rule_key::TEXT AS rule_key,
        mutable_rule.name AS rule_name,
        account.scope,
        account.subject_customer_id,
        account.period,
        public.pylva_budget_timestamp_text(account.period_start) AS period_start,
        public.pylva_budget_timestamp_text(account.period_end) AS period_end,
        account.enforcement,
        public.pylva_budget_decimal_text(account.limit_usd) AS limit_usd,
        public.pylva_budget_decimal_text(account.committed_usd) AS committed_usd,
        public.pylva_budget_decimal_text(account.reserved_usd) AS reserved_usd,
        public.pylva_budget_decimal_text(account.unresolved_usd) AS unresolved_usd,
        public.pylva_budget_decimal_text(GREATEST(
          account.limit_usd - account.committed_usd - account.reserved_usd - account.unresolved_usd,
          0
        )) AS available_usd,
        (account.period_start <= statement_timestamp()
          AND account.period_end > statement_timestamp()) AS is_current
      FROM public.budget_accounts account
      LEFT JOIN public.rules mutable_rule
        ON mutable_rule.builder_id = account.builder_id
       AND mutable_rule.id = account.rule_key
      WHERE ${whereSql}
      ORDER BY is_current DESC, account.period_end DESC, account.updated_at DESC, account.id ASC
      LIMIT ${limit}
    `);
  return unwrapRows<AccountStateRow>(result).map((row) => {
    if (
      typeof row.is_current !== 'boolean' ||
      !validDecimal(row.limit_usd) ||
      !validDecimal(row.committed_usd) ||
      !validDecimal(row.reserved_usd) ||
      !validDecimal(row.unresolved_usd) ||
      !validDecimal(row.available_usd)
    ) {
      throw new Error('budget account state row has an invalid authoritative shape');
    }
    return { ...row, is_current: row.is_current };
  });
}

export async function getBudgetAccountState(
  builderId: string,
  scope: BudgetAccountStateScope,
): Promise<BudgetAccountState[]> {
  validateBudgetAccountStateScope(builderId, scope);
  return withBudgetControlReadTransaction(builderId, (transaction) =>
    getBudgetAccountStateInTransaction(transaction, builderId, scope),
  );
}
