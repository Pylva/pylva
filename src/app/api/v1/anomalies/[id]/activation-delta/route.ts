// GET /api/v1/anomalies/{id}/activation-delta — D41 informational
// delta. Returns the anomaly's recorded baseline period alongside a
// fresh ClickHouse aggregate over the same scope and an equivalent-
// duration window ending now. The dashboard activate-confirmation
// dialog renders both numbers so the builder can see whether the
// recommendation is still relevant before applying it as a rule.
//
// Pure read — no DB mutation, no side effects. Owner / Member both
// allowed since it's informational.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../../lib/auth/builder-context.js';
import { getAnomalyById } from '../../../../../../lib/anomaly/repository.js';
import {
  fetchPeriodAggregates,
  costForExternalCustomer,
} from '../../../../../../lib/anomaly/clickhouse-queries.js';
import { chTimestamp } from '../../../../../../lib/clickhouse/datetime.js';
import { notFoundError } from '../../../../../../lib/errors.js';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  const anomaly = await getAnomalyById(ctx.builderId, id);
  if (!anomaly) return notFoundError(ErrorCode.NOT_FOUND, 'Anomaly not found');

  const windowMs = anomaly.period_end.getTime() - anomaly.period_start.getTime();
  const now = new Date();
  const currentStart = new Date(now.getTime() - windowMs);

  const currentAgg = await fetchPeriodAggregates(
    ctx.builderId,
    chTimestamp(currentStart),
    chTimestamp(now),
  );
  const currentValue = costForExternalCustomer(currentAgg, ctx.builderId, anomaly.customer_id);
  const baselineValue = anomaly.actual_value;

  return NextResponse.json({
    anomaly_id: anomaly.id,
    baseline_period: {
      period_start: anomaly.period_start.toISOString(),
      period_end: anomaly.period_end.toISOString(),
      actual_value: baselineValue,
    },
    current_period: {
      period_start: currentStart.toISOString(),
      period_end: now.toISOString(),
      actual_value: currentValue,
    },
    delta_pct: deltaPct(currentValue, baselineValue),
  });
}

function deltaPct(current: number, baseline: number | null): number | null {
  if (baseline == null || baseline === 0) return null;
  return Math.round(((current - baseline) / baseline) * 10_000) / 100;
}
