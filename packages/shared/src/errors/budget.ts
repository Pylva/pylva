// B2a — shared budget-exceeded shape contract (used by TS + Py SDKs).
// The SDK's PylvaBudgetExceeded class mirrors this shape; the
// backend's BudgetSyncResponse / ingest response `budget_exceeded[]`
// array carries the same fields.

export const PYLVA_BUDGET_EXCEEDED_CODE = 'budget_exceeded' as const;

export const BudgetExceededSource = {
  SDK_PRECALL: 'sdk_precall',
  BACKEND_INGEST_FLAG: 'backend_ingest_flag',
} as const;

export type BudgetExceededSource = (typeof BudgetExceededSource)[keyof typeof BudgetExceededSource];

// Wire shape carried from backend → SDK in POST /api/v1/events response.
// SDK bumps its local accumulator to `limit_usd + 1` for that
// customer (or pooled key) on receipt; next pre-call throws.
export interface BudgetExceededFlag {
  rule_id: string;
  customer_id: string | null; // null iff pooled
  limit_usd: number;
  accumulated_usd: number;
  period: 'hour' | 'day' | 'week' | 'month';
  period_start: string; // ISO 8601
}
