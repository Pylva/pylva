import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';

const ddlPath = path.resolve('db/clickhouse/011_authoritative_budget_projection.sql');
const ddl = fs.readFileSync(ddlPath, 'utf8');
const statements = splitClickHouseStatements(ddl);

describe('authoritative budget ClickHouse projection schema', () => {
  it('creates one event-keyed replacement table and two explicit read views', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/CREATE TABLE IF NOT EXISTS budget_cost_events/);
    expect(statements[0]).toContain('ENGINE = ReplacingMergeTree()');
    expect(statements[0]).toContain('ORDER BY (builder_id, timestamp, event_id, payload_hash)');
    expect(statements[0]).toContain('event_id TYPE bloom_filter(0.01)');
    expect(statements[1]).toMatch(/CREATE VIEW IF NOT EXISTS budget_cost_events_final/);
    expect(statements[1]).toContain('FROM budget_cost_events');
    expect(statements[1]).toContain('GROUP BY builder_id, timestamp, event_id');
    expect(statements[2]).toMatch(/CREATE VIEW IF NOT EXISTS cost_events_with_control/);
    expect(statements[2]).toContain('UNION ALL');
  });

  it('keeps post-provider decimals exact at the NUMERIC(44,18) boundary', () => {
    expect(statements[0]).toContain('cost_usd                Decimal(44,18)');
    expect(statements[0]).toContain('metric_value            Nullable(Decimal(44,18))');
    expect(statements[0]).toContain('abort_savings           Decimal(44,18)');
    expect(statements[2]).toContain("CAST(cost_usd, 'Nullable(Decimal(44,18))')");
  });

  it('does not attach a retry-duplicating materialized view to the physical table', () => {
    expect(ddl).not.toMatch(/CREATE MATERIALIZED VIEW/i);
    expect(ddl).not.toMatch(/SummingMergeTree/i);
    expect(ddl).toContain('Do not attach summing materialized views');
  });

  it('preserves conflicting hashes across replacement merges for reconciliation', () => {
    expect(statements[0]).toContain('ORDER BY (builder_id, timestamp, event_id, payload_hash)');
    expect(statements[1]).toContain(
      'uniqExact(budget_cost_events.payload_hash) AS payload_hash_count',
    );
    expect(statements[1]).not.toContain('HAVING');
    expect(statements[2]).toContain('WHERE payload_hash_count = 1');
    expect(statements[1]).not.toContain(' IN (');
  });

  it('retains controlled billing facts through their immutable billing horizon', () => {
    expect(statements[0]).toContain('retention_days          UInt16');
    expect(statements[0]).toContain('billing_retention_days  UInt16');
    expect(statements[0]).toContain(
      "TTL toDateTime(timestamp, 'UTC') + toIntervalDay(billing_retention_days)",
    );
    expect(statements[0]).toContain(
      "metadata                String TTL toDateTime(timestamp, 'UTC') + toIntervalDay(retention_days)",
    );
    expect(statements[2]).toContain('AND timestamp + toIntervalDay(retention_days) > now()');
  });

  it('preserves current cost-event dimensions and exposes authoritative identities additively', () => {
    for (const column of [
      'timestamp',
      'builder_id',
      'trace_id',
      'span_id',
      'customer_id',
      'provider',
      'model',
      'tokens_in',
      'tokens_out',
      'cost_usd',
      'pricing_status',
      'latency_ms',
      'status',
      'cost_source',
      'instrumentation_tier',
      'metadata',
    ]) {
      expect(statements[0], `missing ${column}`).toContain(column);
    }
    expect(statements[2]).toContain("'authoritative_budget' AS event_origin");
    expect(statements[2]).toContain("'legacy' AS event_origin");
  });
});
