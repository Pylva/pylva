// B2a T3 — POST /api/v1/budget/sync
// SDK-facing reconciliation endpoint (Agent SDK key). Middleware injects
// x-builder-id. Body: { entries: BudgetSyncRequest[] } → { entries: BudgetSyncResponse[] }.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { readBuilderContext } from '@/lib/auth/builder-context';
import { reconcileBudgetSync } from '@/lib/budget/sync-handler';
import { validationError } from '@/lib/errors';

const EntrySchema = v.object({
  rule_id: v.pipe(v.string(), v.uuid()),
  scope: v.picklist(['per_customer', 'pooled']),
  customer_id: v.nullable(v.string()),
  accumulated_cost_usd: v.pipe(v.number(), v.minValue(0)),
  period_start: v.string(),
  event_count: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const BodySchema = v.object({
  entries: v.pipe(v.array(EntrySchema), v.maxLength(500)),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(BodySchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  const entries = await reconcileBudgetSync(ctx.builderId, parsed.output.entries);
  return NextResponse.json({ entries });
}
