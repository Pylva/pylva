// @pylva/sdk — TypeScript SDK public API (v1.0 foundation layer).
//
// Stability contract (D26):
// - Wire format (schema v1.6, POST /api/v1/events): LOCKED.
// - Public SDK API: SemVer-stable from 1.0.0.
//
// Privacy: this SDK NEVER sends prompt, completion, tool-argument, or message
// body text. Telemetry is tokens + model + latency + status + step_name +
// customer_id only. See packages/sdk-ts/README.md "Privacy & PII" section.

import { type InitConfig } from './core/config.js';
import { installSdkConfig } from './core/identity.js';
import { applyAllPatches } from './wrappers/_patch.js';
import { initAccumulator } from './core/budget_accumulator.js';
import { ensurePricingCache } from './core/pricing_cache.js';
import { ensureRulesCache, getCachedRules } from './core/rules_cache.js';
import { validateFailoverWrappers } from './wrappers/_init_validation.js';
export { SDK_VERSION } from './core/version.js';

// Initialize the SDK. Runs config validation synchronously then re-applies
// provider patches defensively (handles HMR / import-order where `openai` was
// imported after auto-patch ran on load). Kicks off the budget accumulator
// sync loop and a one-time failover-wrapper sanity check (D52) once the
// first rules-cache fetch resolves. Both are fire-and-forget.
export function init(config: InitConfig): void {
  installSdkConfig(config);
  try {
    applyAllPatches();
  } catch {
    /* R1 — never surface patch errors */
  }
  void initAccumulator().catch(() => {
    /* R1 */
  });
  // Warm the pricing cache so local budget accounting (recordLlmSpend) can
  // price calls from the first flush onward.
  void ensurePricingCache().catch(() => {
    /* R1 */
  });
  void ensureRulesCache()
    .then(() => validateFailoverWrappers(getCachedRules()))
    .catch(() => {
      /* R1 */
    });
}

export {
  isInitialized,
  InvalidApiKeyError,
  InvalidControlConfigError,
  ControlMode,
  ControlUnavailablePolicy,
} from './core/config.js';
export type {
  InitConfig,
  ResolvedConfig,
  ControlConfig,
  ResolvedControlConfig,
  ControlMode as ControlModeType,
  ControlUnavailablePolicy as ControlUnavailablePolicyType,
} from './core/config.js';

export {
  ready,
  controlStatus,
  reserveUsage,
  commitUsage,
  releaseUsage,
  extendUsage,
  shouldSuppressLegacyTelemetry,
} from './core/control_client.js';
export type {
  ExactDecimalInput,
  ReserveUsageCommonInput,
  LlmReserveUsageInput,
  ToolReserveUsageInput,
  ReserveUsageInput,
  LlmCommitUsageInput,
  ToolCommitUsageInput,
  CommitUsageInput,
  ReleaseUsageInput,
  ExtendUsageInput,
  ControlCapabilities,
  ControlReadyResult,
  BudgetControlWarning,
  BudgetControlRuleSnapshot,
  ReservedUsageResult,
  BypassedUsageResult,
  UnavailableUsageResult,
  ReserveUsageResult,
  CommitUsageResult,
  ControlledOperationTelemetryIdentity,
  ReleaseUsageResult,
  ExtendUsageResult,
} from './core/control_client.js';

export { currentControlledAttempt } from './core/control_correlation.js';
export type { ControlledAttemptCorrelation } from './core/control_correlation.js';
export type { ControlledAttemptOptions } from './core/control_attempt.js';

export { wrapOpenAI } from './wrappers/openai_controlled.js';
export type { ControlledOpenAIClient, StrictOpenAIOptions } from './wrappers/openai_controlled.js';
export { wrapAnthropic } from './wrappers/anthropic_controlled.js';
export type {
  ControlledAnthropicClient,
  StrictAnthropicOptions,
} from './wrappers/anthropic_controlled.js';
export {
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
} from './wrappers/vercel-ai.js';
export type {
  ControlledOpenAIChatModel,
  ControlledOpenAIChatModelOptions,
} from './wrappers/vercel-ai.js';
export { PylvaStrictProviderError } from './wrappers/_usage_bound.js';

export { controlledUsage, controlledExactUsage } from './core/controlled_usage.js';
export type {
  ControlledUsageDecision,
  ControlledUsageSettlement,
  ControlledUsageIssue,
  ControlledUsageOutcome,
  ControlledUsageResult,
  ControlledUsageInput,
  ControlledExactUsageInput,
} from './core/controlled_usage.js';
export {
  controlledTavilySearch,
  TAVILY_SEARCH_COST_SOURCE_SLUG,
  TAVILY_SEARCH_TOOL_NAME,
  TAVILY_SEARCH_METRIC,
  TAVILY_BASIC_SEARCH_CREDITS,
} from './adapters/tavily.js';
export type { TavilySearchClient, ControlledTavilySearchInput } from './adapters/tavily.js';

export { Pylva } from './Pylva.js';
export type { PylvaOptions } from './Pylva.js';
export { getRegisteredClient, hasRegisteredClient } from './core/client_registry.js';
export { track, currentContext } from './core/context.js';
export type { TrackContext, TrackOptions } from './core/context.js';
export { flush, enqueue, bufferSize, isDegraded } from './core/telemetry.js';
export { reportUsage } from './reporting/usage.js';
export type { ReportUsageInput } from './reporting/usage.js';
export { flushNonLlmDiscoveries, normalizeNonLlmMatcher } from './core/non_llm_policy.js';
export type {
  NonLlmConfig,
  NonLlmMode,
  NonLlmPolicyOverride,
  NonLlmPolicyOverrideSource,
  NonLlmToolContext,
  NonLlmUsageExtractor,
} from './core/non_llm_policy.js';
export { verifyWebhook, signWebhook, InvalidSignatureFormat } from './webhooks/verify.js';
export type { VerifyWebhookOptions, SignWebhookResult } from './webhooks/verify.js';

// B2a budget primitives (public API for user-facing try/catch on pre-call throws).
export { PylvaBudgetExceeded, BudgetExceededSource } from './errors/budget_exceeded.js';
export type {
  PylvaBudgetExceededInit,
  AuthoritativeBudgetRuleSnapshot,
  AuthoritativeBudgetWarning,
  AuthoritativeBudgetDenial,
} from './errors/budget_exceeded.js';
export {
  PYLVA_CONTROL_UNAVAILABLE_CODE,
  PylvaControlUnavailableReason,
  PylvaControlUnavailableError,
  PylvaControlApiError,
  PylvaControlValidationError,
} from './errors/control.js';
export type {
  PylvaControlUnavailableReason as PylvaControlUnavailableReasonType,
  PylvaUnavailableResponseEvidence,
  PylvaControlUnavailableErrorInit,
} from './errors/control.js';

export * from './core/schema.js';

// Auto-patch on import (D8/D21). Silent if openai / anthropic / ai are absent.
applyAllPatches();
