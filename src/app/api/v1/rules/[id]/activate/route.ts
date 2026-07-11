// POST /api/v1/rules/{id}/activate — promote a draft rule to active (or
// flip an active rule back to draft). Re-validates the config against the
// tier gate (advanced rules require pro+) and the failover consent flag
// before mutating status. Returns the impact preview so the dashboard
// confirmation card can render the affected customer count + model change
// summary alongside the success state.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { eq } from 'drizzle-orm';
import {
  ErrorCode,
  RuleEnforcement,
  RuleStatus,
  RuleType,
  type BuilderTier,
  type ReliabilityFailoverConfig,
  type Role as RoleType,
  type RuleEnforcement as RuleEnforcementT,
} from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../../lib/auth/builder-context.js';
import { Role, withRole } from '../../../../../../lib/auth/middleware.js';
import { checkFeatureGate } from '../../../../../../lib/auth/tier-enforcement.js';
import { auditLog } from '../../../../../../lib/auth/audit-log.js';
import { AuditAction } from '../../../../../../lib/audit/actions.js';
import { db } from '../../../../../../lib/db/client.js';
import { builders } from '../../../../../../lib/db/schema.js';
import { withRLS } from '../../../../../../lib/db/rls.js';
import { isAdvancedRuleType } from '../../../../../../lib/rules/categories.js';
import { isFeatureEnabled } from '../../../../../../lib/feature-flags.js';
import { getRule, promoteRuleStatus, updateRule } from '../../../../../../lib/rules/repository.js';
import { ruleCreateSchema } from '../../../../../../lib/rules/validator.js';
import { snapshotBackupPrice } from '../../../../../../lib/rules/backup-price-snapshot.js';
import { previewRule } from '../../../../../../lib/rules/preview.js';
import {
  apiError,
  authError,
  forbiddenError,
  notFoundError,
  validationError,
} from '../../../../../../lib/errors.js';
import { logger } from '../../../../../../lib/logger.js';

const log = logger.child({ module: 'rules.activate' });

const BodySchema = v.object({
  status: v.picklist([RuleStatus.ACTIVE, RuleStatus.DRAFT]),
  // Track 3 PR 3.2 (O10): high-risk activation requires the caller to
  // re-type the rule's name verbatim. Required only when promoting to
  // ACTIVE; demotion to DRAFT does not need it.
  confirm_name: v.optional(v.string()),
});

// Track 3 PR 3.2 (O26): when activation would touch more than half of
// known customers, emit a warning in the response. Owner may still
// proceed — this is informational, not a gate.
const HIGH_IMPACT_THRESHOLD_PCT = 50;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  // Activation is a destructive ownership-class action.
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(BodySchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');
  const nextStatus = parsed.output.status;

  const rule = await getRule(ctx.builderId, id);
  if (!rule) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  // Track 3 PR 3.2 (O37): Idempotency-Key replays. If the rule is already
  // in the target status, return the no-op response unchanged. Same-key
  // replays therefore return the same {rule, preview:null, no_op:true}.
  // Cross-key flapping is left to audit-log forensics, not enforced here.
  const idempotencyKey = request.headers.get('Idempotency-Key');

  if (rule.status === nextStatus) {
    return NextResponse.json({
      rule,
      preview: null,
      no_op: true,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });
  }

  // Track 3 PR 3.2 (O10): confirm-by-typing-rule-name on activation.
  // Trim BOTH sides: a rule whose stored name carries stray whitespace
  // (draft path accepts raw strings) was otherwise impossible to confirm —
  // the visible dashboard name never matches the stored one.
  if (nextStatus === RuleStatus.ACTIVE) {
    const provided = (parsed.output.confirm_name ?? '').trim();
    if (provided !== rule.name.trim()) {
      return forbiddenError(
        ErrorCode.VALIDATION_ERROR,
        'activation requires `confirm_name` to match the rule name exactly',
      );
    }
  }

  // F6 (B6): drafts store free-form config (simulator recommendations
  // bypass the create schema), so promotion is the last line of defense —
  // re-validate the full rule against the create schema before it starts
  // affecting live traffic. Invalid drafts 400 and stay draft.
  let enforcementHeal: RuleEnforcementT | null = null;
  if (nextStatus === RuleStatus.ACTIVE) {
    // model_routing / reliability_failover only exist as pre_call rules,
    // but legacy drafts were stored with the post_call default. Heal on
    // promote: the SDK rules fetch filters enforcement=pre_call, so an
    // activated rule left on post_call is never served — dead routing the
    // builder believes is live.
    const canonicalEnforcement =
      (rule.type === RuleType.MODEL_ROUTING || rule.type === RuleType.RELIABILITY_FAILOVER) &&
      rule.enforcement !== RuleEnforcement.PRE_CALL
        ? RuleEnforcement.PRE_CALL
        : rule.enforcement;
    const candidate = v.safeParse(ruleCreateSchema, {
      type: rule.type,
      name: rule.name,
      enabled: rule.enabled,
      customer_id: rule.customer_id,
      enforcement: canonicalEnforcement,
      config: rule.config,
    });
    if (!candidate.success) {
      return validationError(
        `Rule cannot be activated: ${candidate.issues[0]?.message ?? 'invalid rule payload'}`,
        candidate.issues[0]?.path
          ?.map((p) => (typeof p.key === 'string' ? p.key : ''))
          .filter(Boolean)
          .join('.') || 'config',
      );
    }
    if (canonicalEnforcement !== rule.enforcement) enforcementHeal = canonicalEnforcement;
  }

  // Activation gates — only enforce when promoting to ACTIVE. Demoting
  // (active → draft) is always allowed since it's a safer state.
  if (nextStatus === RuleStatus.ACTIVE) {
    if (isAdvancedRuleType(rule.type)) {
      // Track 3 PR 3.2 — operator kill switch (O29). Both env default
      // and per-builder override are honored. Order: flag, then tier,
      // then per-config consent. Without this gate, a builder could
      // activate advanced rules even when ops disabled the feature
      // globally for an outage.
      if (!(await isFeatureEnabled(ctx.builderId, 'ENABLE_ADVANCED_RULES'))) {
        return apiError(
          503,
          'api_error',
          ErrorCode.FEATURE_NOT_AVAILABLE,
          'Advanced rules feature disabled',
        );
      }
      const [builder] = await db
        .select({ tier: builders.tier })
        .from(builders)
        .where(eq(builders.id, ctx.builderId))
        .limit(1);
      if (!builder) {
        return notFoundError(ErrorCode.RESOURCE_NOT_FOUND, 'Builder not found');
      }
      const tierGate = checkFeatureGate(builder.tier as BuilderTier, 'advanced_rules');
      if (tierGate) return tierGate;
    }

    if (rule.type === RuleType.RELIABILITY_FAILOVER) {
      const cfg = rule.config as unknown as ReliabilityFailoverConfig;
      if (!cfg.consent_to_cost_shift) {
        return forbiddenError(
          ErrorCode.VALIDATION_ERROR,
          'reliability_failover requires consent_to_cost_shift=true before activation',
        );
      }
      // D31: snapshot the current backup-model price so the watcher
      // (pricing-sync hook) can detect drift later. Skips silently when
      // no `backup_model` is configured or no active llm_pricing row
      // exists — the watcher treats both as "no snapshot, no alert."
      const snapshot = await snapshotBackupPrice(cfg);
      if (snapshot) {
        await updateRule(ctx.builderId, id, {
          config: snapshot as unknown as Record<string, unknown>,
        });
      } else if (cfg.backup_model) {
        log.warn(
          {
            builder_id: ctx.builderId,
            rule_id: id,
            backup_provider: cfg.backup_provider,
            backup_model: cfg.backup_model,
          },
          'no llm_pricing row for backup model — D31 watcher will skip this rule',
        );
      }
    }
  }

  let preview = null;
  try {
    preview = await previewRule(rule);
  } catch (err) {
    log.warn(
      {
        builder_id: ctx.builderId,
        rule_id: id,
        error: err instanceof Error ? err.message : String(err),
      },
      'preview failed during activation; proceeding without impact summary',
    );
  }

  if (enforcementHeal) {
    await updateRule(ctx.builderId, id, { enforcement: enforcementHeal });
  }

  const updated = await promoteRuleStatus(ctx.builderId, id, nextStatus);
  if (!updated) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  // Track 3 PR 3.2 (O26): compute impact percentage for the response +
  // audit log. matched_customers is the uncapped uniqExact numerator; the
  // affected_customers list is a TOP_N display sample whose length floored
  // impact at 20/N for large builders (B11).
  const affectedCount = preview?.matched_customers ?? preview?.affected_customers.length ?? 0;
  const totalCustomers = preview?.total_customers ?? 0;
  const impactPct = totalCustomers > 0 ? Math.round((affectedCount / totalCustomers) * 100) : null;
  const highImpactWarning = impactPct !== null && impactPct >= HIGH_IMPACT_THRESHOLD_PCT;

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action:
        nextStatus === RuleStatus.ACTIVE
          ? AuditAction.RULE_ACTIVATED
          : AuditAction.RULE_DEACTIVATED,
      resource_type: 'rule',
      resource_id: id,
      details: {
        rule_type: rule.type,
        // Track 3 PR 3.2 — config snapshot is the why-we-can-replay-this
        // -decision evidence. Without it, post-incident forensics on
        // "why did failover get activated for primary=openai?" requires
        // correlating with rule update history. Use `updated.config`
        // (the post-snapshot row from promoteRuleStatus's RETURNING
        // clause) so consent_backup_input_per_1m_usd /
        // consent_backup_output_per_1m_usd / consent_observed_at —
        // which snapshotBackupPrice persisted just before this audit
        // writes — make it into the audit row. The local `rule` is
        // pre-snapshot and would lose them.
        config: updated.config,
        affected_customer_count: affectedCount,
        impact_pct: impactPct,
        high_impact_warning: highImpactWarning,
        live_traffic_warning: preview?.live_traffic_warning ?? null,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      },
    });
  });

  log.info(
    {
      builder_id: ctx.builderId,
      rule_id: id,
      rule_type: rule.type,
      next_status: nextStatus,
      affected_customer_count: preview?.affected_customers.length ?? null,
      live_traffic_warning: preview?.live_traffic_warning ?? null,
    },
    nextStatus === RuleStatus.ACTIVE ? 'rule activated' : 'rule deactivated',
  );

  return NextResponse.json({
    rule: updated,
    preview,
    no_op: false,
    impact_pct: impactPct,
    high_impact_warning: highImpactWarning,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
}
