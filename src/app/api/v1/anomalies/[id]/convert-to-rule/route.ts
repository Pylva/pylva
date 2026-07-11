// POST /api/v1/anomalies/{id}/convert-to-rule — "Apply as rule" path
// (D11). Creates a draft model_routing rule from the anomaly's
// `recommendation.draft_rule`, stamps `source_anomaly_id` so the
// activate flow can compute the D41 activation-time delta, and flips
// the anomaly to status='converted_to_rule'. Returns both the rule and
// the updated anomaly so the dashboard can route the user to the
// rules page with the new draft selected.
//
// Owner-only. Idempotent on the anomaly side: re-converting an
// already-converted anomaly returns the previously created rule (we
// look it up by `config.source_anomaly_id`). Re-conversion is rare —
// the dashboard hides the action once status flips — but the guard
// prevents accidental double-creation on a network retry.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  AnomalyRecommendationAction,
  AnomalyStatus,
  ErrorCode,
  RuleStatus,
  RuleType,
  type ModelRoutingConfig,
  type Role as RoleType,
} from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../../lib/auth/builder-context.js';
import { Role, withRole } from '../../../../../../lib/auth/middleware.js';
import { auditLog } from '../../../../../../lib/auth/audit-log.js';
import { AuditAction } from '../../../../../../lib/audit/actions.js';
import { withRLS } from '../../../../../../lib/db/rls.js';
import { rules } from '../../../../../../lib/db/schema.js';
import { getAnomalyById, updateAnomalyStatus } from '../../../../../../lib/anomaly/repository.js';
import { createRule, getRule } from '../../../../../../lib/rules/repository.js';
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
  const anomaly = await getAnomalyById(ctx.builderId, id);
  if (!anomaly) return notFoundError(ErrorCode.NOT_FOUND, 'Anomaly not found');

  if (
    anomaly.recommendation.action !== AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE
  ) {
    return validationError(
      `Anomaly recommendation is '${anomaly.recommendation.action}', not 'create_draft_model_routing_rule'`,
      'recommendation',
    );
  }
  if (!anomaly.recommendation.draft_rule) {
    return validationError(
      'Anomaly recommendation is missing draft_rule payload',
      'recommendation',
    );
  }

  // Idempotent re-conversion: if a rule already references this
  // anomaly, return it instead of creating a duplicate.
  const existingRuleId = await findRuleBySourceAnomaly(ctx.builderId, id);
  if (existingRuleId) {
    const existing = await getRule(ctx.builderId, existingRuleId);
    if (existing) {
      return NextResponse.json({ rule: existing, anomaly, no_op: true });
    }
  }
  // Defense-in-depth (merged_bug_005): the dashboard UI only renders
  // the "Apply as rule" button for OPEN anomalies, but Owner-only API
  // consumers can still POST here. Without this guard, a DISMISSED
  // row whose recommendation still has `action='create_draft_…'`
  // would materialize a fresh draft rule from stale diagnosis data
  // and silently flip the anomaly back to CONVERTED_TO_RULE,
  // overriding the operator's prior dismiss decision. The runbook's
  // documented contract is `WHERE status='open'`; mirror it here.
  // The idempotent-rule check above handles re-conversion of an
  // already-converted anomaly; this guard catches the dismiss-then-
  // convert path.
  if (anomaly.status !== AnomalyStatus.OPEN) {
    return validationError(`Cannot convert anomaly in status '${anomaly.status}'`, 'status');
  }

  const draftConfig: ModelRoutingConfig = {
    ...anomaly.recommendation.draft_rule,
    source_anomaly_id: anomaly.id,
  };
  const created = await createRule({
    builder_id: ctx.builderId,
    type: RuleType.MODEL_ROUTING,
    name: `Anomaly ${anomaly.id.slice(0, 8)} — ${anomaly.source_type}`,
    enabled: false,
    customer_id: anomaly.customer_id,
    config: draftConfig as unknown as Record<string, unknown>,
    status: RuleStatus.DRAFT,
  });

  const updatedAnomaly = await updateAnomalyStatus(
    ctx.builderId,
    id,
    AnomalyStatus.CONVERTED_TO_RULE,
  );

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.RECOMMENDATION_CONVERTED,
      resource_type: 'anomaly_event',
      resource_id: id,
      details: {
        rule_id: created.id,
        source_type: anomaly.source_type,
      },
    });
  });

  return NextResponse.json(
    { rule: created, anomaly: updatedAnomaly, no_op: false },
    { status: 201 },
  );
}

async function findRuleBySourceAnomaly(
  builderId: string,
  anomalyId: string,
): Promise<string | null> {
  // JSONB key lookup avoids materializing every rule's config —
  // `config->>'source_anomaly_id' = $1` is index-scannable when a GIN
  // index lands later. For now the table is small enough that the
  // sequential scan is acceptable.
  return withRLS(builderId, async (tx) => {
    const rows = await tx
      .select({ id: rules.id })
      .from(rules)
      .where(
        and(
          eq(rules.builder_id, builderId),
          sql`${rules.config}->>'source_anomaly_id' = ${anomalyId}`,
        ),
      )
      .limit(1);
    return rows[0]?.id ?? null;
  });
}
