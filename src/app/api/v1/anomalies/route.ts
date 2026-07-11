// GET /api/v1/anomalies — dashboard list of anomalies for the current
// builder. Default filter is status=open; pass `?status=dismissed` /
// `?status=converted_to_rule` for the historical views. ENABLE_ADVANCED_RULES
// kill switch returns an empty list rather than 503 so dashboard pages
// still render when the feature is operator-disabled.
//
// Tier gate: anomalies are an advanced-rules surface (Pro+); free-tier
// builders see an empty list. Mirrors the rules list endpoint.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { eq } from 'drizzle-orm';
import {
  AnomalyStatus,
  ErrorCode,
  type AnomalyStatus as AnomalyStatusType,
  type BuilderTier,
} from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../lib/auth/builder-context.js';
import { db } from '../../../../lib/db/client.js';
import { builders } from '../../../../lib/db/schema.js';
import { env } from '../../../../lib/config.js';
import { listAnomalies } from '../../../../lib/anomaly/repository.js';
import { checkFeatureGate } from '../../../../lib/auth/tier-enforcement.js';
import { notFoundError, validationError } from '../../../../lib/errors.js';

const QuerySchema = v.object({
  status: v.optional(
    v.picklist([AnomalyStatus.OPEN, AnomalyStatus.DISMISSED, AnomalyStatus.CONVERTED_TO_RULE]),
  ),
  customer_id: v.optional(v.string()),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.transform((s) => Number(s)),
      v.minValue(1),
      v.maxValue(200),
    ),
  ),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(request.url);
  const parsed = v.safeParse(QuerySchema, {
    status: url.searchParams.get('status') ?? undefined,
    customer_id: url.searchParams.get('customer_id') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success)
    return validationError(parsed.issues[0]?.message ?? 'Invalid query', 'query');

  if (!env.ENABLE_ADVANCED_RULES) {
    return NextResponse.json({ anomalies: [], feature_disabled: true });
  }

  const [builder] = await db
    .select({ tier: builders.tier })
    .from(builders)
    .where(eq(builders.id, ctx.builderId))
    .limit(1);
  if (!builder) return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');

  const tierGate = checkFeatureGate(builder.tier as BuilderTier, 'advanced_rules');
  if (tierGate) {
    return NextResponse.json({ anomalies: [], feature_disabled: true });
  }

  const anomalies = await listAnomalies(ctx.builderId, {
    status: parsed.output.status as AnomalyStatusType | undefined,
    customerId: parsed.output.customer_id,
    limit: parsed.output.limit,
  });
  return NextResponse.json({ anomalies });
}
