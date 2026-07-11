export const REQUIRED_CLICKHOUSE_TABLES = [
  'cost_events',
  'cost_daily_agg_v2',
  'cost_daily_agg_v2_mv',
  'cost_customer_daily_agg',
  'cost_customer_daily_agg_mv',
  'cost_model_daily_agg',
  'cost_model_daily_agg_mv',
  'cost_model_daily_agg_backfill_status',
] as const;

export const REQUIRED_COST_EVENTS_COLUMNS = [
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
  kind?: unknown;
  name?: unknown;
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
        SELECT 'table' AS kind, name
          FROM system.tables
         WHERE database = currentDatabase()
           AND name IN {tables:Array(String)}
        UNION ALL
        SELECT 'column' AS kind, name
          FROM system.columns
         WHERE database = currentDatabase()
           AND table = 'cost_events'
           AND name IN {columns:Array(String)}
      `,
      query_params: {
        tables: [...REQUIRED_CLICKHOUSE_TABLES],
        columns: [...REQUIRED_COST_EVENTS_COLUMNS],
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
    ];

    if (missingTables.length === 0 && missingColumns.length === 0) {
      const aggregateResponse = await client.query({
        query: `
          SELECT 'cost_events_presence' AS kind,
                 if(count() > 0, 'present', 'empty') AS name
            FROM (SELECT 1 FROM cost_events LIMIT 1)
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
