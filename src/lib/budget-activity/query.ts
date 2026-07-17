import {
  BUDGET_ACTIVITY_STATUSES,
  type BudgetActivityKind,
  type BudgetActivityQuery,
  type BudgetActivityStatus,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_SOURCE_PATTERN = /^[^\u0000-\u001f\u007f]{1,255}$/;
const STATUS_SET = new Set<string>(BUDGET_ACTIVITY_STATUSES);

export const DEFAULT_BUDGET_ACTIVITY_PAGE_SIZE = 25;
export const MAX_BUDGET_ACTIVITY_PAGE_SIZE = 100;

export class BudgetActivityQueryError extends Error {
  readonly param: string;

  constructor(param: string, message: string) {
    super(message);
    this.name = 'BudgetActivityQueryError';
    this.param = param;
  }
}

function optionalTrimmed(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function boundedInteger(
  raw: string | null,
  fallback: number,
  maximum: number,
  param: string,
): number {
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new BudgetActivityQueryError(param, `${param} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new BudgetActivityQueryError(param, `${param} must be at most ${maximum}`);
  }
  return value;
}

export function parseBudgetActivityQuery(params: URLSearchParams): BudgetActivityQuery {
  const rawStatus = optionalTrimmed(params, 'status') ?? 'all';
  if (rawStatus !== 'all' && !STATUS_SET.has(rawStatus)) {
    throw new BudgetActivityQueryError(
      'status',
      `status must be all or one of ${BUDGET_ACTIVITY_STATUSES.join(', ')}`,
    );
  }

  const rawKind = optionalTrimmed(params, 'kind') ?? 'all';
  if (rawKind !== 'all' && rawKind !== 'llm' && rawKind !== 'tool') {
    throw new BudgetActivityQueryError('kind', 'kind must be all, llm, or tool');
  }

  const customer = optionalTrimmed(params, 'customer');
  if (customer !== null && !CUSTOMER_ID_PATTERN.test(customer)) {
    throw new BudgetActivityQueryError(
      'customer',
      'customer must be a valid external end-user identifier',
    );
  }

  const source = optionalTrimmed(params, 'source');
  if (source !== null && !SAFE_SOURCE_PATTERN.test(source)) {
    throw new BudgetActivityQueryError('source', 'source must be 1-255 printable characters');
  }

  const traceId = optionalTrimmed(params, 'trace_id');
  if (traceId !== null && !UUID_PATTERN.test(traceId)) {
    throw new BudgetActivityQueryError('trace_id', 'trace_id must be a UUID');
  }

  const ruleKey = optionalTrimmed(params, 'rule_key');
  if (ruleKey !== null && !UUID_PATTERN.test(ruleKey)) {
    throw new BudgetActivityQueryError('rule_key', 'rule_key must be a UUID');
  }

  return {
    status: rawStatus as BudgetActivityStatus | 'all',
    kind: rawKind as BudgetActivityKind | 'all',
    customer,
    source,
    trace_id: traceId?.toLowerCase() ?? null,
    rule_key: ruleKey?.toLowerCase() ?? null,
    page: boundedInteger(params.get('page'), 1, 100_000, 'page'),
    page_size: boundedInteger(
      params.get('page_size'),
      DEFAULT_BUDGET_ACTIVITY_PAGE_SIZE,
      MAX_BUDGET_ACTIVITY_PAGE_SIZE,
      'page_size',
    ),
  };
}

export function budgetActivityQueryToSearchParams(query: BudgetActivityQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.status !== 'all') params.set('status', query.status);
  if (query.kind !== 'all') params.set('kind', query.kind);
  if (query.customer !== null) params.set('customer', query.customer);
  if (query.source !== null) params.set('source', query.source);
  if (query.trace_id !== null) params.set('trace_id', query.trace_id);
  if (query.rule_key !== null) params.set('rule_key', query.rule_key);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.page_size !== DEFAULT_BUDGET_ACTIVITY_PAGE_SIZE) {
    params.set('page_size', String(query.page_size));
  }
  return params;
}
