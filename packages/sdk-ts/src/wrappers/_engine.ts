// Wrapper-side engine glue. Provider wrappers call `runWithEngine()`
// instead of invoking the original SDK directly so that pre-call budget
// enforcement, model routing, and failover state tracking all run in one
// place. Cross-provider routing/failover is intentionally not executed
// here — the wrapper for the routed/backup provider must be loaded; this
// wrapper records that gap as a warning instead.

import {
  RuleDecisionAction,
  RuleWarningCode,
  type RuleWarning,
  type ReliabilityFailoverConfig,
} from '@pylva/shared/rules';
import { getCachedRules } from '../core/rules_cache.js';
import { evaluatePreCall, type PreCallContext } from '../core/rules_engine.js';
import { isActive, recordOutcome } from '../core/failover.js';
import { attemptWithFallback } from '../core/model_routing.js';
import { currentContext } from '../core/context.js';
import { hasRegisteredClient } from '../core/client_registry.js';
import { maybeEnforcePreCall } from './_budget.js';
import { PylvaBudgetExceeded } from '../errors/budget_exceeded.js';
import { getConfigGeneration } from '../core/config.js';

export interface EngineRequestShape {
  /** Mutable copy of request args[0] — wrappers pass a shallow copy so
   *  routing can swap `.model` without mutating the host app's input. */
  request: { model?: string } & Record<string, unknown>;
  providerId: string;
  /** Issues the underlying provider call with the (possibly mutated)
   *  request. Wrappers close over any subsequent original args. */
  call: (request: Record<string, unknown>) => Promise<unknown>;
  ctx: PreCallContext;
}

export interface PylvaResponseMetadata {
  original_model: string | null;
  routed_model?: string;
  routing_applied: boolean;
  failover_active: boolean;
  warnings?: RuleWarning[];
}

export interface EngineResult<T> {
  result: T;
  metadata: PylvaResponseMetadata;
}

/**
 * Build the per-call engine context from AsyncLocalStorage + request.
 * Used by every wrapper — keeping it here prevents drift between
 * openai/anthropic/vercel-ai on `?? null` vs `?? undefined`.
 */
export function buildEngineCtx(providerId: string, model: string | null): PreCallContext {
  const ctx = currentContext();
  return {
    // Telemetry attributes untracked calls to 'anonymous' (_event.ts), so
    // enforcement must use the same identity — a `null` here landed on a
    // different accumulator key than the backend's budget_exceeded flags,
    // leaving untracked traffic permanently unblockable.
    customer_id: ctx?.customer_id ?? 'anonymous',
    step_name: ctx?.step_name ?? null,
    provider: providerId,
    model,
  };
}

/**
 * Single entry point for wrapper integration. Throws
 * PylvaBudgetExceeded before any provider call when the pre-call hook
 * hard-blocks. Records failover outcome on both success and provider-call
 * failure paths so wrappers only need to handle telemetry on rethrow.
 */
export async function runWithEngine<T>(input: EngineRequestShape): Promise<EngineResult<T>> {
  const ownerGeneration = getConfigGeneration();
  // maybeEnforcePreCall already warms the rules cache via ensureRulesCache.
  maybeEnforcePreCall({ customer_id: input.ctx.customer_id, estimated_usd: 0 });

  const evaluation = evaluatePreCall(getCachedRules(), input.ctx);
  const failoverCfg: ReliabilityFailoverConfig | null = evaluation.failover?.cfg ?? null;
  const warnings: RuleWarning[] = [];

  // Cross-provider failover requires the backup wrapper. We can detect
  // the active state but can't *act* on it from inside the primary's
  // wrapper today (cross-provider dispatch with shape-adapter is a v2
  // follow-up). We surface the gap and proceed with the primary call.
  //
  // PR #84 review (bug_028) — emit a warning on EVERY active-failover
  // call, but distinguish:
  //   - MISSING_BACKUP: builder hasn't registered the backup client at
  //     all → tells them what to do.
  //   - DISPATCH_NOT_IMPLEMENTED: builder has registered the backup but
  //     v1 doesn't route there yet → tells them this is a known gap.
  // Without the second signal, builders who do the right thing
  // (`new Pylva({ openai, anthropic })`) see `failover_active=true`
  // with zero warnings even though every call still hits the failing
  // primary — silent broken state.
  const failoverActive = failoverCfg ? isActive(failoverCfg) : false;
  if (failoverCfg && failoverActive) {
    if (hasRegisteredClient(failoverCfg.backup_provider)) {
      warnings.push({
        code: RuleWarningCode.FAILOVER_DISPATCH_NOT_IMPLEMENTED,
        message: `Failover active for ${failoverCfg.primary_provider} → ${failoverCfg.backup_provider}; backup client is registered but cross-provider dispatch is not yet implemented. Calls continue on the failing primary until the v2 follow-up lands.`,
      });
    } else {
      warnings.push({
        code: RuleWarningCode.FAILOVER_MISSING_BACKUP,
        message: `Failover active for ${failoverCfg.primary_provider} → ${failoverCfg.backup_provider}, but no ${failoverCfg.backup_provider} client is registered. Pass one via \`new Pylva({ providers: { "${failoverCfg.backup_provider}": client } })\` so failover can route there.`,
      });
    }
  }

  const originalModel = input.request.model ?? null;
  let routingApplied = false;
  let routedModel: string | undefined;
  let result: T;

  try {
    if (evaluation.decision.action === RuleDecisionAction.ROUTE_MODEL) {
      const decision = evaluation.decision;
      const isSameProvider = decision.provider === input.providerId;
      if (!isSameProvider) {
        warnings.push({
          code: RuleWarningCode.ROUTING_CROSS_PROVIDER_SKIPPED,
          message: `Cross-provider routing (${input.providerId} → ${decision.provider}) requires the ${decision.provider} wrapper. Routing skipped; original model used.`,
        });
        result = (await input.call(input.request)) as T;
      } else {
        const attempt = await attemptWithFallback<T>({
          call: async (model) => (await input.call({ ...input.request, model })) as T,
          routedModel: decision.model,
          originalModel: decision.original_model || (originalModel ?? ''),
          isSameProvider: true,
          fallback: decision.fallback,
        });
        result = attempt.result;
        routingApplied = !attempt.fellBack;
        routedModel = attempt.modelUsed;
        if (attempt.fellBack && attempt.fallbackReason) {
          warnings.push({
            code: attempt.fallbackReason,
            message: `Routed model failed; fell back to original ${decision.original_model}.`,
          });
        }
      }
    } else {
      result = (await input.call(input.request)) as T;
    }
  } catch (err) {
    if (failoverCfg && ownerGeneration === getConfigGeneration()) {
      recordOutcome(failoverCfg, false);
    }
    throw err;
  }

  if (failoverCfg && ownerGeneration === getConfigGeneration()) {
    recordOutcome(failoverCfg, true);
  }

  const metadata: PylvaResponseMetadata = {
    original_model: originalModel,
    routing_applied: routingApplied,
    failover_active: failoverActive,
  };
  if (routedModel !== undefined) metadata.routed_model = routedModel;
  if (warnings.length > 0) metadata.warnings = warnings;
  return { result, metadata };
}

/**
 * Tag the response object so host apps can introspect routing/failover
 * decisions. Mutates in place — provider responses are POJOs, not shared
 * references the host app holds before the await resolves.
 */
export function attachPylvaMetadata<T extends object>(
  response: T,
  metadata: PylvaResponseMetadata,
): T & { _pylva: PylvaResponseMetadata } {
  return Object.assign(response, { _pylva: metadata });
}

/**
 * SDK-thrown errors that represent deliberate budget refusals rather than
 * provider failures. Wrappers use this to skip FAILURE telemetry so refusals
 * don't poison provider error-rate dashboards.
 */
export function isIntentionalRefusal(err: unknown): boolean {
  return err instanceof PylvaBudgetExceeded;
}
