import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { splitClickHouseStatements } from '../../db/clickhouse-statements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

describe('splitClickHouseStatements', () => {
  it('keeps statements that start with comments', () => {
    const ddl = fs.readFileSync(path.join(repoRoot, 'db/clickhouse/001_cost_events.sql'), 'utf8');

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS cost_events');
    expect(statements[1]).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg');
    expect(statements[1]).toContain('sum(ifNull(cost_usd, toDecimal64(0, 6))) AS total_cost_usd');
    expect(statements[1]).toContain('SETTINGS allow_nullable_key = 1');
  });

  it('drops trailing comment-only blocks', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/003_cost_events_demo_flag.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('ADD COLUMN IF NOT EXISTS is_demo');
  });

  it('keeps Step 11 raw retention TTL hardening statement', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/005_cost_events_retention_policies.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('MODIFY TTL timestamp + INTERVAL 1 YEAR');
    expect(statements[0]).not.toContain('ALTER TABLE cost_daily_agg');
  });

  it('keeps customer daily aggregate table and materialized view statements', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/006_cost_customer_daily_agg.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS cost_customer_daily_agg');
    expect(statements[0]).toContain('ORDER BY (builder_id, is_demo, day, customer_id)');
    expect(statements[0]).toContain('SimpleAggregateFunction(sum, Decimal(38,6))');
    expect(statements[0]).toContain('SimpleAggregateFunction(max, DateTime)');
    expect(statements[1]).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS');
    expect(statements[1]).toContain(
      "CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)'",
    );
    expect(statements[1]).toContain('GROUP BY day, builder_id, customer_id, is_demo');
  });

  it('keeps daily aggregate v2 target, materialized view, and legacy drop statements', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/008_cost_daily_agg_v2.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS cost_daily_agg_v2');
    expect(statements[0]).toContain(
      'ORDER BY (builder_id, customer_id, day, provider, model, step_name, billing_retention_days)',
    );
    expect(statements[0]).toContain('TTL day + toIntervalDay(billing_retention_days)');
    expect(statements[0]).toContain('total_cost_usd Decimal(38,6)');
    expect(statements[1]).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS cost_daily_agg_v2_mv');
    expect(statements[1]).toContain('TO cost_daily_agg_v2');
    expect(statements[1]).toContain('sum(ifNull(cost_usd, toDecimal64(0, 6))) AS total_cost_usd');
    expect(statements[1]).toContain(
      'GROUP BY builder_id, customer_id, day, provider, model, step_name, billing_retention_days',
    );
    expect(statements[2]).toBe('DROP VIEW IF EXISTS cost_daily_agg;');
  });

  it('keeps customer daily aggregate retention statements deterministic', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/009_cost_customer_daily_agg_retention.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS billing_retention_days SimpleAggregateFunction(max, UInt16) DEFAULT 365',
    );
    expect(statements[1]).toContain('ALTER TABLE cost_customer_daily_agg_mv');
    expect(statements[1]).toContain('MODIFY QUERY SELECT');
    expect(statements[1]).toContain(
      "CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)'",
    );
    expect(statements[1]).toContain('max(billing_retention_days) AS billing_retention_days');
    expect(statements[1]).toContain('GROUP BY day, builder_id, customer_id, is_demo');
    expect(statements[1]).not.toContain('DROP VIEW');
    expect(statements[2]).toContain('MODIFY TTL day + toIntervalDay(billing_retention_days)');
  });

  it('keeps model daily aggregate table, materialized view, and trust status statements', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/010_cost_model_daily_agg.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS cost_model_daily_agg');
    expect(statements[0]).toContain('ORDER BY (builder_id, is_demo, day, provider, model)');
    expect(statements[0]).toContain('SimpleAggregateFunction(sum, Decimal(38,6))');
    expect(statements[0]).toContain('SimpleAggregateFunction(max, UInt16)');
    expect(statements[0]).toContain('TTL day + toIntervalDay(billing_retention_days)');
    expect(statements[0]).toContain('SETTINGS allow_nullable_key = 1');
    expect(statements[1]).toContain('CREATE MATERIALIZED VIEW IF NOT EXISTS');
    expect(statements[1]).toContain('TO cost_model_daily_agg');
    expect(statements[1]).toContain(
      "CAST(sum(ifNull(cost_usd, toDecimal64(0, 6))), 'Decimal(38,6)'",
    );
    expect(statements[1]).toContain('max(billing_retention_days) AS billing_retention_days');
    expect(statements[1]).toContain('GROUP BY day, builder_id, is_demo, provider, model');
    expect(statements[2]).toContain(
      'CREATE TABLE IF NOT EXISTS cost_model_daily_agg_backfill_status',
    );
    expect(statements[2]).toContain('status               LowCardinality(String)');
    expect(statements[2]).toContain('source_cost_usd      Decimal(38,6)');
    expect(statements[2]).toContain('aggregate_call_count UInt64');
    expect(statements[2]).toContain('DateTime64(6) DEFAULT now64(6)');
  });

  it('keeps per-row retention column and TTL statements separate', () => {
    const ddl = fs.readFileSync(
      path.join(repoRoot, 'db/clickhouse/007_cost_events_retention_days.sql'),
      'utf8',
    );

    const statements = splitClickHouseStatements(ddl);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('ADD COLUMN IF NOT EXISTS retention_days UInt16 DEFAULT 365');
    expect(statements[1]).toContain(
      'ADD COLUMN IF NOT EXISTS billing_retention_days UInt16 DEFAULT 365',
    );
    expect(statements[2]).toContain('MODIFY TTL timestamp + toIntervalDay(retention_days)');
  });
});
