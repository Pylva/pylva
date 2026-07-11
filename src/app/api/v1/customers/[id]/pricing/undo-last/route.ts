// B2b T2-B — POST /api/v1/customers/[id]/pricing/undo-last
//
// I-T2-12: 10-second undo window. Reverts the most-recent pricing version if
// its effective_from is within `UNDO_WINDOW_SECONDS`; past that → 410 gone.
//
// Race: two tabs clicking Save + Undo in quick succession. The second undo
// lands on a state where the newest version's effective_from is already the
// one created by the first undo's "reopen prior" — not a separate row. We
// rely on the window check: if the first undo already fired, the newest
// version is now the previously-prior version, and its effective_from is
// older than 10s → second undo returns 410.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { Role, type Role as RoleType, ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { validationError, goneError, internalError } from '@/lib/errors';
import { undoLastVersion } from '@/lib/billing/pricing-versioning';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'billing.pricing.undo' });

export const UNDO_WINDOW_SECONDS = 10;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const roleGate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (roleGate) return roleGate;

  const { id: customerId } = await params;
  if (!v.is(v.pipe(v.string(), v.uuid()), customerId)) {
    return validationError('Invalid customer id', 'id');
  }

  try {
    const result = await undoLastVersion({
      builderId: ctx.builderId,
      customerId,
      maxAgeSeconds: UNDO_WINDOW_SECONDS,
    });

    if (result === null) {
      return goneError(
        ErrorCode.NOT_FOUND,
        `Undo window expired (${UNDO_WINDOW_SECONDS}s) or no version to undo`,
      );
    }

    if (ctx.userId) {
      await withRLS(ctx.builderId, async (tx) => {
        await auditLog(tx, {
          builder_id: ctx.builderId,
          actor_type: 'user',
          actor_id: ctx.userId!,
          action: AuditAction.BILLING_PRICING_UNDO,
          resource_type: 'customer_pricing',
          details: { customer_id: customerId, restored_version: result.restoredVersion },
        });
      });
    }

    return NextResponse.json({ restored_version: result.restoredVersion });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { builder_id: ctx.builderId, customer_id: customerId, error: message },
      'pricing undo failed',
    );
    return internalError('Failed to undo pricing change');
  }
}
