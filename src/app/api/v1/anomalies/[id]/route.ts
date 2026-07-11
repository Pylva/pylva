// GET /api/v1/anomalies/{id} — single anomaly with full diagnosis +
// recommendation. Anomaly context panel uses this when navigated from
// an alert deep-link or the Recommendations tab.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../lib/auth/builder-context.js';
import { getAnomalyById } from '../../../../../lib/anomaly/repository.js';
import { notFoundError } from '../../../../../lib/errors.js';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { id } = await params;
  const anomaly = await getAnomalyById(ctx.builderId, id);
  if (!anomaly) return notFoundError(ErrorCode.NOT_FOUND, 'Anomaly not found');
  return NextResponse.json({ anomaly });
}
