export const REQUIRED_CLICKHOUSE_TABLES = [
  'cost_events',
  'cost_daily_agg_v2',
  'cost_daily_agg_v2_mv',
  'cost_customer_daily_agg',
  'cost_customer_daily_agg_mv',
  'cost_model_daily_agg',
  'cost_model_daily_agg_mv',
  'cost_model_daily_agg_backfill_status',
  'budget_cost_events',
  'budget_cost_events_final',
  'cost_events_with_control',
] as const;

export const REQUIRED_COST_EVENTS_COLUMNS = [
  'timestamp',
  'builder_id',
  'customer_id',
  'cost_usd',
  'pricing_status',
  'is_demo',
  'savings_usd',
  'retention_days',
  'billing_retention_days',
  'metadata',
] as const;

export const REQUIRED_COST_EVENTS_COLUMN_TYPES = {
  timestamp: "DateTime('UTC')",
} as const;

export const REQUIRED_BUDGET_COST_EVENT_COLUMNS = {
  event_id: 'UUID',
  payload_hash: 'FixedString(64)',
  timestamp: "DateTime64(3,'UTC')",
  builder_id: 'String',
  customer_id: 'String',
  tokens_in: 'UInt32',
  tokens_out: 'UInt32',
  cost_usd: 'Decimal(44,18)',
  metric: 'Nullable(String)',
  metric_value: 'Nullable(Decimal(44,18))',
  retention_days: 'UInt16',
  billing_retention_days: 'UInt16',
  metadata: 'String',
} as const;

export const AUTHORITATIVE_BUDGET_SORTING_KEY =
  'builder_id, timestamp, event_id, payload_hash' as const;

export const REQUIRED_AUTHORITATIVE_TABLE_CONTRACTS = {
  budget_cost_events: {
    engine: 'ReplacingMergeTree',
    sortingKey: AUTHORITATIVE_BUDGET_SORTING_KEY,
    primaryKey: AUTHORITATIVE_BUDGET_SORTING_KEY,
    definitionFragments: [
      'ttl todatetime(timestamp, utc) + tointervalday(billing_retention_days)',
      'metadata string ttl todatetime(timestamp, utc) + tointervalday(retention_days)',
      'index budget_cost_events_event_id_bf event_id type bloom_filter(0.01) granularity 1',
    ],
  },
  budget_cost_events_final: {
    engine: 'View',
    sortingKey: '',
    primaryKey: '',
    definitionFragments: [
      'budget_cost_events',
      'group by builder_id, timestamp, event_id',
      'uniqexact(budget_cost_events.payload_hash) as payload_hash_count',
    ],
  },
  cost_events_with_control: {
    engine: 'View',
    sortingKey: '',
    primaryKey: '',
    definitionFragments: [
      'union all',
      'budget_cost_events_final',
      'payload_hash_count = 1',
      'timestamp + tointervalday(retention_days)',
      '> now()',
    ],
  },
} as const;

export interface ClickHouseReadinessCheck {
  name: string;
  ok: boolean;
  missing?: string[];
  message?: string;
}

export interface ClickHouseReadinessResult {
  ready: boolean;
  checks: ClickHouseReadinessCheck[];
}

interface JsonResult {
  json(): Promise<unknown>;
}

export interface ClickHouseReadinessClient {
  query(params: {
    query: string;
    format: 'JSONEachRow';
    query_params?: Record<string, unknown>;
  }): Promise<JsonResult>;
}

interface MetadataRow {
  definition?: unknown;
  engine?: unknown;
  kind?: unknown;
  name?: unknown;
  primary_key?: unknown;
  sorting_key?: unknown;
  type?: unknown;
}

function normalizedDefinition(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[`"']/g, '').replace(/\s+/g, ' ')
    : '';
}

function normalizedType(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, '') : '';
}

function authoritativeSchemaFailures(rows: MetadataRow[]): string[] {
  const failures: string[] = [];
  const tableRows = new Map(
    rows
      .filter((row) => row.kind === 'table' && typeof row.name === 'string')
      .map((row) => [row.name as string, row]),
  );
  for (const [name, contract] of Object.entries(REQUIRED_AUTHORITATIVE_TABLE_CONTRACTS)) {
    const row = tableRows.get(name);
    if (row?.engine !== contract.engine) failures.push(`${name}.engine`);
    if (row?.sorting_key !== contract.sortingKey) failures.push(`${name}.sorting_key`);
    if (row?.primary_key !== contract.primaryKey) failures.push(`${name}.primary_key`);
    const definition = normalizedDefinition(row?.definition);
    for (const fragment of contract.definitionFragments) {
      if (!definition.includes(fragment)) failures.push(`${name}.definition`);
    }
    if (name === 'budget_cost_events_final' && definition.includes(' in (')) {
      failures.push(`${name}.global_identity_set`);
    }
  }

  const budgetColumns = new Map(
    rows
      .filter((row) => row.kind === 'budget_column' && typeof row.name === 'string')
      .map((row) => [row.name as string, row]),
  );
  for (const [name, expectedType] of Object.entries(REQUIRED_BUDGET_COST_EVENT_COLUMNS)) {
    if (normalizedType(budgetColumns.get(name)?.type) !== normalizedType(expectedType)) {
      failures.push(`budget_cost_events.${name}.type`);
    }
  }
  return [...new Set(failures)].sort();
}

function costEventsSchemaFailures(rows: MetadataRow[]): string[] {
  const columns = new Map(
    rows
      .filter((row) => row.kind === 'column' && typeof row.name === 'string')
      .map((row) => [row.name as string, row]),
  );
  const failures: string[] = [];
  for (const [name, expectedType] of Object.entries(REQUIRED_COST_EVENTS_COLUMN_TYPES)) {
    const row = columns.get(name);
    if (row && normalizedType(row.type) !== normalizedType(expectedType)) {
      failures.push(`cost_events.${name}.type`);
    }
  }
  return failures;
}

function sanitizeClickHouseMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|password|secret|token)=\S+/gi, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export function failedClickHouseReadinessChecks(
  result: ClickHouseReadinessResult,
): ClickHouseReadinessCheck[] {
  return result.checks.filter((check) => !check.ok);
}

export async function checkClickHouseReadiness(
  client: ClickHouseReadinessClient,
): Promise<ClickHouseReadinessResult> {
  try {
    const response = await client.query({
      query: `
        SELECT 'table' AS kind,
               name,
               engine,
               sorting_key,
               primary_key,
               create_table_query AS definition,
               '' AS type
          FROM system.tables
         WHERE database = currentDatabase()
           AND name IN {tables:Array(String)}
        UNION ALL
        SELECT 'column' AS kind,
               name,
               '' AS engine,
               '' AS sorting_key,
               '' AS primary_key,
               '' AS definition,
               type
          FROM system.columns
         WHERE database = currentDatabase()
           AND table = 'cost_events'
           AND name IN {columns:Array(String)}
        UNION ALL
        SELECT 'budget_column' AS kind,
               name,
               '' AS engine,
               '' AS sorting_key,
               '' AS primary_key,
               '' AS definition,
               type
          FROM system.columns
         WHERE database = currentDatabase()
           AND table = 'budget_cost_events'
           AND name IN {budget_columns:Array(String)}
      `,
      query_params: {
        tables: [...REQUIRED_CLICKHOUSE_TABLES],
        columns: [...REQUIRED_COST_EVENTS_COLUMNS],
        budget_columns: Object.keys(REQUIRED_BUDGET_COST_EVENT_COLUMNS),
      },
      format: 'JSONEachRow',
    });
    const rows = (await response.json()) as MetadataRow[];

    const tables = new Set(
      rows
        .filter((row) => row.kind === 'table' && typeof row.name === 'string')
        .map((row) => row.name as string),
    );
    const columns = new Set(
      rows
        .filter((row) => row.kind === 'column' && typeof row.name === 'string')
        .map((row) => row.name as string),
    );

    const missingTables = REQUIRED_CLICKHOUSE_TABLES.filter((table) => !tables.has(table));
    const missingColumns = REQUIRED_COST_EVENTS_COLUMNS.filter((column) => !columns.has(column));
    const costEventSchemaFailures = costEventsSchemaFailures(rows);
    const schemaFailures = authoritativeSchemaFailures(rows);
    const checks: ClickHouseReadinessCheck[] = [
      { name: 'clickhouse.responds', ok: true },
      {
        name: 'clickhouse.tables',
        ok: missingTables.length === 0,
        ...(missingTables.length > 0 ? { missing: missingTables } : {}),
      },
      {
        name: 'clickhouse.cost_events_columns',
        ok: missingColumns.length === 0,
        ...(missingColumns.length > 0 ? { missing: missingColumns } : {}),
      },
      {
        name: 'clickhouse.cost_events_schema',
        ok: costEventSchemaFailures.length === 0,
        ...(costEventSchemaFailures.length > 0
          ? {
              missing: costEventSchemaFailures,
              message: 'cost_events ClickHouse schema is missing or stale',
            }
          : {}),
      },
      {
        name: 'clickhouse.authoritative_budget_schema',
        ok: schemaFailures.length === 0,
        ...(schemaFailures.length > 0
          ? {
              missing: schemaFailures,
              message: 'authoritative budget ClickHouse schema is missing or stale',
            }
          : {}),
      },
    ];

    if (
      missingTables.length === 0 &&
      missingColumns.length === 0 &&
      costEventSchemaFailures.length === 0 &&
      schemaFailures.length === 0
    ) {
      const aggregateResponse = await client.query({
        query: `
          SELECT 'cost_events_presence' AS kind,
                 if(count() > 0, 'present', 'empty') AS name
            FROM (
              SELECT 1
                FROM cost_events_with_control
               WHERE event_origin = 'legacy'
               LIMIT 1
            )
          UNION ALL
          SELECT 'model_agg_status' AS kind,
                 if(count() = 0, 'missing', any(status)) AS name
            FROM (
              SELECT status
                FROM cost_model_daily_agg_backfill_status
               ORDER BY checked_at DESC
               LIMIT 1
            )
        `,
        format: 'JSONEachRow',
      });
      const aggregateRows = (await aggregateResponse.json()) as MetadataRow[];
      const rawEventsPresent = aggregateRows.some(
        (row) => row.kind === 'cost_events_presence' && row.name === 'present',
      );
      const modelAggregateTrusted = aggregateRows.some(
        (row) => row.kind === 'model_agg_status' && row.name === 'trusted',
      );
      const ok = !rawEventsPresent || modelAggregateTrusted;

      checks.push({
        name: 'clickhouse.model_daily_agg_backfill',
        ok,
        ...(ok
          ? {}
          : {
              message: 'cost_model_daily_agg has not been verified against existing cost_events',
            }),
      });
    }

    return {
      ready: failedClickHouseReadinessChecks({ ready: false, checks }).length === 0,
      checks,
    };
  } catch (err) {
    return {
      ready: false,
      checks: [
        {
          name: 'clickhouse.responds',
          ok: false,
          message: sanitizeClickHouseMessage(err),
        },
      ],
    };
  }
}

export const __clickHouseReadinessTesting = {
  authoritativeSchemaFailures,
  costEventsSchemaFailures,
  normalizedDefinition,
  normalizedType,
};
