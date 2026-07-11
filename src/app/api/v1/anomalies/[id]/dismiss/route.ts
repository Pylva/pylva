// POST /api/v1/anomalies/{id}/dismiss — flip an OPEN anomaly to DISMISSED.
// Idempotent: dismissing an already-dismissed anomaly returns the same
// row (the partial unique index from migration 030 still allows the
// same shape to recur in a future period). Owner-only.

import { NextResponse, type NextRequest } from 'next/server.js';
import { AnomalyStatus, ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../../lib/auth/builder-context.js';
import { Role, withRole } from '../../../../../../lib/auth/middleware.js';
import { auditLog } from '../../../../../../lib/auth/audit-log.js';
import { AuditAction } from '../../../../../../lib/audit/actions.js';
import { withRLS } from '../../../../../../lib/db/rls.js';
import { getAnomalyById, updateAnomalyStatus } from '../../../../../../lib/anomaly/repository.js';
import { authError, notFoundError, validationError } from '../../../../../../lib/errors.js';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { id } = await params;
  const existing = await getAnomalyById(ctx.builderId, id);
  if (!existing) return notFoundError(ErrorCode.NOT_FOUND, 'Anomaly not found');

  if (existing.status === AnomalyStatus.DISMISSED) {
    return NextResponse.json({ anomaly: existing, no_op: true });
  }
  // Defense-in-depth (merged_bug_005): the dashboard UI hides the
  // dismiss button on non-OPEN rows, but Owner-only API consumers
  // (scripted retries, support tooling) can still POST here. Without
  // this guard, a CONVERTED_TO_RULE row would silently flip to
  // DISMISSED and orphan the linked draft rule's source_anomaly_id
  // reference. The runbook's documented contract is `WHERE
  // status='open'`; mirror it here.
  if (existing.status !== AnomalyStatus.OPEN) {
    return validationError(`Cannot dismiss anomaly in status '${existing.status}'`, 'status');
  }

  const updated = await updateAnomalyStatus(ctx.builderId, id, AnomalyStatus.DISMISSED);
  if (!updated) return notFoundError(ErrorCode.NOT_FOUND, 'Anomaly not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.ANOMALY_DISMISSED,
      resource_type: 'anomaly_event',
      resource_id: id,
      details: {
        source_type: existing.source_type,
        customer_id: existing.customer_id,
      },
    });
  });

  return NextResponse.json({ anomaly: updated, no_op: false });
}
