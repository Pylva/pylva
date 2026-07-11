// ClickHouse event-insert helpers for ingest (B1 — §7.2 / §7.4).
// Wraps the existing insertCostEvents with a single 100ms retry on transient
// failure. On second failure, the error propagates — the route returns 500
// and the SDK retries per its own backoff schedule.
//
// Row shape matches db/clickhouse/001_cost_events.sql plus later cost_events
// column migrations (pricing status, demo/savings flags, retention days).
// cost_usd is Nullable(Decimal(10,6)) after migration 002 — caller passes null
// for unpriced events + pricing_status='needs_input'. Computed costs and
// abort_savings are guarded before this boundary so one oversized value cannot
// DECIMAL_OVERFLOW and fail the whole batch insert.

import { insertCostEvents as baseInsert } from './client.js';
import { chTimestamp } from './datetime.js';
import { logger } from '../logger.js';

export interface CostEventRow {
  timestamp: string; // ingest timestamp; serialized to ClickHouse DateTime before insert
  builder_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  customer_id: string; // composite: {builder_id}:{customer_external_id}
  provider: string; // LowCardinality, non-null — fallback 'other'
  model: string | null;
  operation: string; // LowCardinality, non-null — derived from step_name or 'unknown'
  step_name: string | null;
  tokens_in: number; // UInt32
  tokens_out: number; // UInt32
  cost_usd: number | null; // Nullable(Decimal(10,6))
  pricing_status: 'priced' | 'needs_input' | 'pending';
  latency_ms: number; // UInt32
  status: string; // LowCardinality
  cost_source: string; // LowCardinality: auto | configured
  instrumentation_tier: string; // LowCardinality: sdk_wrapper | reported
  metric: string | null;
  metric_value: number | null; // Float64
  stream_aborted: 0 | 1; // UInt8
  abort_savings: number; // Decimal(10,6)
  retention_days: number; // UInt16, stamped at ingest from builder tier
  billing_retention_days: number; // UInt16, used by later billing aggregate targets
  metadata: string; // JSON string
}

const log = logger.child({ module: 'clickhouse.events' });

function serializeForClickHouse(rows: CostEventRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    ...row,
    timestamp: chTimestamp(new Date(row.timestamp)),
  }));
}

/**
 * Insert event rows with a single retry on failure. Second failure throws
 * so the caller can return 500 to the SDK.
 */
export async function insertCostEventsWithRetry(rows: CostEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const serializedRows = serializeForClickHouse(rows);
  try {
    await baseInsert(serializedRows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { attempt: 1, rows: rows.length, error: message },
      'clickhouse insert failed, retrying',
    );
    await new Promise((r) => setTimeout(r, 100));
    try {
      await baseInsert(serializedRows);
    } catch (err2) {
      const message2 = err2 instanceof Error ? err2.message : String(err2);
      log.error(
        { attempt: 2, rows: rows.length, error: message2 },
        'clickhouse insert failed, giving up',
      );
      throw err2;
    }
  }
}
