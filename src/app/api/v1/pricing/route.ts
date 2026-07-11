// GET /api/v1/pricing — global LLM pricing read (B1 — D22).
// Auth: API key + Agent SDK scope (middleware). Shares SDK rate limit.
// SDK caches response for 24h via pricing_cache.ts.

import { NextResponse, type NextRequest } from 'next/server.js';
import { sql as drizzleSql } from 'drizzle-orm';
import { db } from '../../../../lib/db/client.js';
import { unwrapRows } from '../../../../lib/db/query-utils.js';
import { logger } from '../../../../lib/logger.js';
import { internalError } from '../../../../lib/errors.js';
import { readBuilderContext } from '../../../../lib/auth/builder-context.js';

const log = logger.child({ module: 'pricing' });

type LlmPricingRow = {
  id: number;
  provider: string;
  model: string;
  input_per_1m: string;
  output_per_1m: string;
  effective_from: Date | string;
  effective_to: Date | string | null;
  source: 'auto' | 'admin';
  created_at: Date | string;
} & Record<string, unknown>;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;

  try {
    // llm_pricing is global (no RLS); effective_to semantics = currently active.
    const result = await db.execute<LlmPricingRow>(drizzleSql`
      SELECT id, provider, model,
             input_per_1m::text AS input_per_1m,
             output_per_1m::text AS output_per_1m,
             effective_from, effective_to, source, created_at
      FROM llm_pricing
      WHERE effective_to IS NULL OR effective_to > NOW()
      ORDER BY provider, model, effective_from DESC
    `);

    const models = unwrapRows<LlmPricingRow>(result).map((r) => ({
      id: Number(r.id),
      provider: r.provider,
      model: r.model,
      input_per_1m: Number(r.input_per_1m),
      output_per_1m: Number(r.output_per_1m),
      effective_from: new Date(r.effective_from),
      effective_to: r.effective_to ? new Date(r.effective_to) : null,
      source: r.source,
      created_at: new Date(r.created_at),
    }));

    return NextResponse.json(
      { models, updated_at: new Date().toISOString() },
      { status: 200, headers: { 'Cache-Control': 'public, max-age=86400' } },
    );
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'pricing read failed');
    return internalError('failed to read pricing');
  }
}
