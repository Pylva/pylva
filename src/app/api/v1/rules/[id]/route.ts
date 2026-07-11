// B2a T3 — /api/v1/rules/[id]
// GET: anyone on the builder; PUT/DELETE: Owner-only (I-T1-10).
// PATCH for toggle via ?toggle=true query.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { eq } from 'drizzle-orm';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { deleteRule, getRule, toggleRule, updateRule } from '@/lib/rules/repository';
import { isAdvancedRuleType } from '@/lib/rules/categories';
import { POOLED_TARGETING_MESSAGE, ruleUpdateSchema } from '@/lib/rules/validator';
import { withRole, Role } from '@/lib/auth/middleware';
import { checkFeatureGate } from '@/lib/auth/tier-enforcement';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { db } from '@/lib/db/client';
import { builders } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';
import { customerExternalIdExists } from '@/lib/customers/lookup';
import { authError, forbiddenError, notFoundError, validationError } from '@/lib/errors';
import {
  customerIdSchema,
  ErrorCode,
  RuleScope,
  RuleStatus,
  RuleType,
  type BuilderTier,
  type ReliabilityFailoverConfig,
  type Role as RoleType,
} from '@pylva/shared';

const PatchSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  enabled: v.optional(v.boolean()),
  customer_id: v.optional(v.nullable(customerIdSchema)),
  config: v.optional(v.record(v.string(), v.unknown())),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  const rule = await getRule(ctx.builderId, id);
  if (!rule) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');
  return NextResponse.json({ rule });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(PatchSchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid patch', 'body');

  // Toggle shortcut: { enabled: ... } is an allowed mutation for Members.
  // Anything else (name, customer_id, config) is Owner-only.
  const isOwnerOnly =
    parsed.output.name !== undefined ||
    parsed.output.customer_id !== undefined ||
    parsed.output.config !== undefined;
  if (isOwnerOnly) {
    const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
    if (gate) return gate;
  }

  if (
    parsed.output.customer_id &&
    !(await customerExternalIdExists(ctx.builderId, parsed.output.customer_id))
  ) {
    return validationError('Select an existing end-user for this rule.', 'customer_id');
  }

  // Config/retarget edits validate the MERGED rule against the same
  // per-type schema as create (B5): PATCH previously accepted any
  // `config` shape, so a typo'd key silently produced a dead rule (empty
  // budget config enforces nothing) or an overbroad one (`match: {}` on
  // model_routing reroutes every call). Drafts keep free-form config —
  // activation re-validates (F6) — but still reject the pooled+targeted
  // contradiction so a draft can't be steered into a state activation
  // must always refuse.
  let validatedConfig: Record<string, unknown> | undefined;
  if (parsed.output.config !== undefined || parsed.output.customer_id !== undefined) {
    const existing = await getRule(ctx.builderId, id);
    if (!existing) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

    const merged = {
      type: existing.type,
      name: parsed.output.name ?? existing.name,
      enabled: parsed.output.enabled ?? existing.enabled,
      customer_id:
        parsed.output.customer_id !== undefined ? parsed.output.customer_id : existing.customer_id,
      enforcement: existing.enforcement,
      config: parsed.output.config ?? existing.config,
    };

    if (existing.status === RuleStatus.DRAFT) {
      const scope = (merged.config as { scope?: unknown }).scope;
      if (scope === RuleScope.POOLED && merged.customer_id) {
        return validationError(POOLED_TARGETING_MESSAGE, 'customer_id');
      }
    } else {
      const validated = v.safeParse(ruleUpdateSchema, merged);
      if (!validated.success) {
        return validationError(
          validated.issues[0]?.message ?? 'Invalid rule payload',
          validated.issues[0]?.path
            ?.map((p) => (typeof p.key === 'string' ? p.key : ''))
            .filter(Boolean)
            .join('.') || 'config',
        );
      }
      // Persist the parsed config so schema defaults (e.g. cost_threshold
      // scope) are stamped exactly like the create path.
      if (parsed.output.config !== undefined) {
        validatedConfig = validated.output.config as Record<string, unknown>;
      }
    }

    // Advanced-type config edits re-run the same gates as activation: tier
    // gate (pro+) and failover-consent on enable. Otherwise an Owner could
    // mutate a model_routing or reliability_failover rule's config after
    // their tier downgraded, or flip consent_to_cost_shift while enabled.
    if (parsed.output.config !== undefined && isAdvancedRuleType(existing.type)) {
      const [builder] = await db
        .select({ tier: builders.tier })
        .from(builders)
        .where(eq(builders.id, ctx.builderId))
        .limit(1);
      if (!builder) return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');
      const tierGate = checkFeatureGate(builder.tier as BuilderTier, 'advanced_rules');
      if (tierGate) return tierGate;
    }
    if (parsed.output.config !== undefined && existing.type === RuleType.RELIABILITY_FAILOVER) {
      const cfg = parsed.output.config as Partial<ReliabilityFailoverConfig>;
      const isEnabled = cfg.enabled ?? (existing.config as { enabled?: boolean }).enabled ?? false;
      const hasConsent =
        cfg.consent_to_cost_shift ??
        (existing.config as { consent_to_cost_shift?: boolean }).consent_to_cost_shift ??
        false;
      if (isEnabled && !hasConsent) {
        return forbiddenError(
          ErrorCode.VALIDATION_ERROR,
          'reliability_failover.enabled requires consent_to_cost_shift=true',
        );
      }
    }
  }

  const next =
    parsed.output.enabled !== undefined && !isOwnerOnly
      ? await toggleRule(ctx.builderId, id, parsed.output.enabled)
      : await updateRule(
          ctx.builderId,
          id,
          validatedConfig !== undefined
            ? { ...parsed.output, config: validatedConfig }
            : parsed.output,
        );

  if (!next) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: isOwnerOnly ? AuditAction.RULE_UPDATE : AuditAction.RULE_TOGGLE,
      resource_type: 'rule',
      resource_id: id,
      details: parsed.output as Record<string, unknown>,
    });
  });

  return NextResponse.json({ rule: next });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { id } = await params;
  const ok = await deleteRule(ctx.builderId, id);
  if (!ok) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.RULE_DELETE,
      resource_type: 'rule',
      resource_id: id,
    });
  });

  return NextResponse.json({ ok: true });
}
