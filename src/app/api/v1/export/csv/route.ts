// B2a T1 — GET /api/v1/export/csv?customer_id=&from=&to=
// Streaming CSV export (I-T1-8: first chunk < 500 ms at 100 K rows).
// Keyset pagination on (timestamp DESC, span_id DESC) in 5K-row chunks.
// No maxDuration cap (D4, §2a). ECS streams until done; client-side retry
// if ALB connection drops (documented in cookbook).

import { type NextRequest } from 'next/server.js';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { queryCostEvents } from '@/lib/clickhouse/client';
import { chTimestamp } from '@/lib/clickhouse/datetime';
import { extractExternalCustomerId, toCompositeCustomerId } from '@/lib/clickhouse/customer-id';
import { NextResponse } from 'next/server.js';
import { csvEscape } from '@/lib/csv';
import { parseRange } from '../../costs/route';

const CHUNK_SIZE = 5_000;

const CSV_HEADER = [
  'timestamp',
  'trace_id',
  'span_id',
  'parent_span_id',
  'customer_id',
  'provider',
  'model',
  'operation',
  'step_name',
  'tokens_in',
  'tokens_out',
  'cost_usd',
  'latency_ms',
  'status',
  'is_demo',
].join(',');

interface CursorKey {
  timestamp: string; // ClickHouse DateTime string
  span_id: string; // UUID
}

function rowToCsv(r: Record<string, unknown>, builderId: string): string {
  return [
    r.timestamp,
    r.trace_id,
    r.span_id,
    r.parent_span_id,
    extractExternalCustomerId(r.customer_id as string, builderId),
    r.provider,
    r.model,
    r.operation,
    r.step_name,
    r.tokens_in,
    r.tokens_out,
    r.cost_usd,
    r.latency_ms,
    r.status,
    r.is_demo,
  ]
    .map(csvEscape)
    .join(',');
}

export async function GET(request: NextRequest): Promise<Response> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const range = parseRange(searchParams);
  if (range instanceof NextResponse) return range;

  // Use || so empty-string param is treated as absent (not a bare-string filter).
  const rawCustomerId = searchParams.get('customer_id') || undefined;
  // CSV route calls queryCostEvents directly — convert to composite here.
  const customerId = rawCustomerId
    ? toCompositeCustomerId(ctx.builderId, rawCustomerId)
    : undefined;
  const filename = `pylva-costs-${range.from.toISOString().slice(0, 10)}-to-${range.to.toISOString().slice(0, 10)}.csv`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(CSV_HEADER + '\n'));

      let cursor: CursorKey | null = null;
      let chunksWritten = 0;

      try {
        while (true) {
          const cursorFilter = cursor
            ? 'AND (timestamp, span_id) < ({cursor_ts:DateTime}, {cursor_span:UUID})'
            : '';
          const customerFilter = customerId ? 'AND customer_id = {customer_id:String}' : '';

          const rows = await queryCostEvents(
            ctx.builderId,
            `SELECT timestamp, trace_id, span_id, parent_span_id, customer_id,
                    provider, model, operation, step_name,
                    tokens_in, tokens_out, cost_usd, latency_ms, status, is_demo
             FROM cost_events
             WHERE builder_id = {builder_id:String}
               AND timestamp >= {from:DateTime}
               AND timestamp <= {to:DateTime}
               ${customerFilter}
               ${cursorFilter}
             ORDER BY timestamp DESC, span_id DESC
             LIMIT {limit:UInt32}`,
            {
              from: chTimestamp(range.from),
              to: chTimestamp(range.to),
              limit: CHUNK_SIZE,
              ...(customerId ? { customer_id: customerId } : {}),
              ...(cursor ? { cursor_ts: cursor.timestamp, cursor_span: cursor.span_id } : {}),
            },
          );

          if (rows.length === 0) break;

          const chunk =
            (rows as Array<Record<string, unknown>>)
              .map((r) => rowToCsv(r, ctx.builderId))
              .join('\n') + '\n';
          controller.enqueue(encoder.encode(chunk));
          chunksWritten += rows.length;

          const last = rows[rows.length - 1] as Record<string, unknown>;
          cursor = {
            timestamp: last.timestamp as string,
            span_id: last.span_id as string,
          };
          if (rows.length < CHUNK_SIZE) break;
        }
        void chunksWritten; // silence unused for lint
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Best-effort trailing comment so the consumer can spot the abort.
        try {
          controller.enqueue(encoder.encode(`# error: ${csvEscape(message)}\n`));
        } finally {
          controller.error(err);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
