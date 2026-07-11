// B2a T3 — /api/v1/rules
// GET: SDK-facing (Agent SDK key auth via middleware). Returns
//      RulesResponse { rules, ttl_seconds, fetched_at } for the rules_cache.
// POST: dashboard CRUD (JWT auth via middleware). Owner+Member both allowed.
//
// Middleware has already authenticated + set x-builder-id. See src/middleware.ts
// for the method-based auth dispatch.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { readBuilderContext, readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { createRule, listRules } from '@/lib/rules/repository';
import { ruleCreateSchema, isSupportedRuleType } from '@/lib/rules/validator';
import { validationError } from '@/lib/errors';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { customerExternalIdExists } from '@/lib/customers/lookup';
import {
  RuleEnforcement,
  RuleStatus,
  type RulesResponse,
  type RuleType as RuleTypeType,
} from '@pylva/shared';
import { isAdvancedRuleType } from '@/lib/rules/categories';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Either Agent SDK key authed (SDK fetch) or dashboard-JWT-authed.
  const isSdkAuth = !!request.headers.get('x-key-id');
  const ctxOrErr = isSdkAuth
    ? readBuilderContext(request)
    : readBuilderContextFromDashboard(request);
  if (ctxOrErr instanceof NextResponse) return ctxOrErr;

  // SDK fetch (api-key auth): only active, enabled, non-draft pre-call rules.
  // Cache payload stays small + the SDK engine doesn't need to filter
  // post-call rules it can't act on. Dashboard fetch returns everything so
  // the rules page can show drafts + disabled + post-call rules in tabs.
  const all = await listRules(
    ctxOrErr.builderId,
    isSdkAuth
      ? { excludeDrafts: true, excludeDisabled: true, enforcement: RuleEnforcement.PRE_CALL }
      : undefined,
  );

  const response: RulesResponse = {
    rules: all,
    ttl_seconds: 60,
    fetched_at: new Date().toISOString(),
  };
  return NextResponse.json(response);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const rawBody = body as Record<string, unknown> | null;
  const isDraft = rawBody?.status === RuleStatus.DRAFT;

  if (rawBody && typeof rawBody === 'object' && rawBody.type === 'customer_throttle') {
    return validationError(
      "Rule type 'customer_throttle' has been removed. Use budget_limit hard stops to cap customer usage.",
      'type',
    );
  }

  // Unknown types are rejected for drafts too (F6/B6): activation now
  // schema-validates against the per-type create schema, so a made-up type
  // would only produce a permanently unactivatable draft row — reject it
  // at the door instead. Draft *config* stays free-form until promotion.
  if (rawBody && typeof rawBody === 'object' && 'type' in rawBody) {
    const t = rawBody.type;
    if (typeof t === 'string' && !isSupportedRuleType(t)) {
      return validationError(`Rule type '${t.slice(0, 64)}' is not supported`, 'type');
    }
  }

  let created;

  if (isDraft) {
    if (!rawBody?.type || typeof rawBody.type !== 'string') {
      return validationError('Draft rule requires a type', 'type');
    }
    if (!rawBody?.name || typeof rawBody.name !== 'string') {
      return validationError('Draft rule requires a name', 'name');
    }
    created = await createRule({
      builder_id: ctx.builderId,
      type: rawBody.type as RuleTypeType,
      name: rawBody.name,
      enabled: false,
      customer_id: null,
      config: (rawBody.config as Record<string, unknown>) ?? {},
      status: RuleStatus.DRAFT,
    });
  } else {
    const parsed = v.safeParse(ruleCreateSchema, body);
    if (!parsed.success) {
      return validationError(
        parsed.issues[0]?.message ?? 'Invalid rule payload',
        parsed.issues[0]?.path
          ?.map((p) => (typeof p.key === 'string' ? p.key : ''))
          .filter(Boolean)
          .join('.') || 'body',
      );
    }
    if (
      parsed.output.customer_id &&
      !(await customerExternalIdExists(ctx.builderId, parsed.output.customer_id))
    ) {
      return validationError('Select an existing end-user for this rule.', 'customer_id');
    }
    const isAdvanced = isAdvancedRuleType(parsed.output.type);
    created = await createRule({
      builder_id: ctx.builderId,
      type: parsed.output.type,
      name: parsed.output.name,
      enabled: parsed.output.enabled,
      customer_id: parsed.output.customer_id ?? null,
      config: parsed.output.config as Record<string, unknown>,
      // Advanced types (model_routing, reliability_failover, margin_protection)
      // start as drafts; the dashboard activate route flips them after the
      // builder reviews the impact preview.
      ...(isAdvanced ? { status: RuleStatus.DRAFT } : {}),
      ...('enforcement' in parsed.output && parsed.output.enforcement
        ? { enforcement: parsed.output.enforcement }
        : {}),
    });
  }

  if (ctx.userId) {
    await withRLS(ctx.builderId, async (tx) => {
      await auditLog(tx, {
        builder_id: ctx.builderId,
        actor_type: 'user',
        actor_id: ctx.userId!,
        action: AuditAction.RULE_CREATE,
        resource_type: 'rule',
        resource_id: created.id,
        details: { type: created.type },
      });
    });
  }

  return NextResponse.json({ rule: created }, { status: 201 });
}
