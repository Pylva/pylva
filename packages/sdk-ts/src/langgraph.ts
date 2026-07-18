// LangChain/LangGraph callback handler for Pylva cost telemetry.
//
// This entrypoint intentionally does NOT import ./index.js. The root SDK
// auto-patches provider clients on import; callback users should not get
// provider auto-patching unless they explicitly import the root package too.

import { randomUUID } from 'node:crypto';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
  Provider,
  TokenCountSource,
} from '@pylva/shared/telemetry-values';
import type { TelemetryEvent } from '@pylva/shared/telemetry';
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import { getConfigGeneration, type InitConfig } from './core/config.js';
import { installSdkConfig, snapshotStandaloneNonLlmConfig } from './core/identity.js';
import { currentContext } from './core/context.js';
import {
  completeControlledCallback,
  controlledOperationForCallbackStart,
  registerControlledCallback,
  withControlledCallbackScope,
  type ControlledCallbackLink,
  type ControlledOperationCorrelation,
} from './core/control_correlation.js';
import { initAccumulator } from './core/budget_accumulator.js';
import { ensurePricingCache } from './core/pricing_cache.js';
import { enqueue, flush } from './core/telemetry.js';
import {
  configureNonLlmPolicy,
  decideNonLlmTool,
  ensureNonLlmPolicy,
  metricValueForSource,
  nonLlmMode,
  recordNonLlmDiscovery,
  warnLegacyToolTrackingOnce,
  type NonLlmConfig,
  type NonLlmMode,
} from './core/non_llm_policy.js';

type JsonishRecord = Record<string, unknown>;
type RunKind = 'chain' | 'llm' | 'tool';

interface RunState {
  generation: number;
  runKey: string;
  parentRunKey: string | null;
  run_id: string;
  parent_run_id: string | null;
  trace_id: string;
  customer_id: string | null;
  step_name: string | null;
  provider: Provider | null;
  model: string | null;
  run_name: string | null;
  started_at: number;
  metadata: JsonishRecord;
  kind: RunKind;
  controlled_operation: ControlledOperationCorrelation | null;
  controlled_callback: ControlledCallbackLink | null;
  tool_input?: unknown;
}

interface UsageResult {
  tokensIn: number;
  tokensOut: number;
  model: string | null;
  provider: Provider | null;
  found: boolean;
}

const MAX_COMPLETED_RUN_TOMBSTONES = 10_000;

export type PylvaCallbackLlmTrackingMode = 'auto' | 'callback' | 'off';

/**
 * Bind one LangGraph/LangChain model or tool invocation to the exact controlled
 * provider attempt that executes inside it.
 */
export function withLangGraphControlScope<T>(invoke: () => T): T {
  return withControlledCallbackScope(invoke);
}

export interface PylvaCallbackHandlerOptions extends Omit<InitConfig, 'apiKey'> {
  apiKey?: string;
  customerId?: string;
  trackToolCalls?: boolean;
  nonLlm?: NonLlmConfig;
  flushOnChainEnd?: boolean;
  /**
   * `auto` lets an exact active Pylva provider wrapper own LLM billing,
   * `callback` is for callback-only instrumentation, and `off` ignores LLMs.
   */
  llmTracking?: PylvaCallbackLlmTrackingMode;
}

export class PylvaCallbackHandler implements CallbackHandlerMethods {
  name = 'pylva_callback_handler';
  ignoreLLM: boolean;
  ignoreChain = false;
  ignoreAgent = false;
  ignoreRetriever = true;
  ignoreCustomEvent = true;
  raiseError = false;
  awaitHandlers = true;

  private readonly customerId: string | null;
  private readonly observeToolCalls: boolean;
  private readonly nonLlmMode: NonLlmMode;
  private readonly nonLlmConfig: NonLlmConfig | undefined;
  private readonly flushOnChainEnd: boolean;
  private readonly llmTracking: PylvaCallbackLlmTrackingMode;
  private readonly fallbackGeneration: number;
  private readonly runs = new Map<string, RunState>();
  // Keep a terminal tombstone after deleting run state. An old-identity
  // callback may be delivered more than once; without the tombstone, the
  // duplicate would take the no-start fallback path and inherit the current
  // tenant generation. A real start for a reused run ID clears the tombstone.
  private readonly completedRuns = new Map<string, number>();

  constructor(options: PylvaCallbackHandlerOptions = {}) {
    // Read and validate every caller-controlled option before installSdkConfig
    // can replace the process identity. A getter or Proxy trap must never make
    // construction fail after a new credential has already been published.
    const {
      llmTracking: llmTrackingValue,
      customerId: customerIdValue,
      apiKey,
      trackToolCalls: trackToolCallsValue,
      flushOnChainEnd: flushOnChainEndValue,
      endpoint,
      batchSize,
      flushInterval,
      localMode,
      nonLlm: nonLlmValue,
      control,
    } = options;
    const llmTracking = parseLlmTrackingMode(llmTrackingValue);
    const customerId = cleanCustomerId(customerIdValue);
    const trackToolCalls = parseOptionalBoolean(trackToolCallsValue, 'trackToolCalls');
    const flushOnChainEnd = parseOptionalBoolean(flushOnChainEndValue, 'flushOnChainEnd');
    let nonLlmConfig: NonLlmConfig | undefined;

    if (apiKey !== undefined) {
      const resolved = installSdkConfig({
        apiKey,
        endpoint,
        batchSize,
        flushInterval,
        localMode,
        nonLlm: nonLlmValue,
        control,
      });
      nonLlmConfig = resolved.nonLlm;
      void initAccumulator().catch(() => {
        /* R1 */
      });
      // Warm the pricing cache so local budget accounting (recordLlmSpend)
      // can price calls from the first flush onward.
      void ensurePricingCache().catch(() => {
        /* R1 */
      });
    } else {
      nonLlmConfig = snapshotStandaloneNonLlmConfig(nonLlmValue);
      configureNonLlmPolicy(nonLlmConfig);
    }

    this.llmTracking = llmTracking;
    this.ignoreLLM = llmTracking === 'off';
    this.customerId = customerId;
    this.nonLlmConfig = nonLlmConfig;
    this.nonLlmMode = nonLlmMode(nonLlmConfig, trackToolCalls);
    this.observeToolCalls = this.nonLlmMode !== 'off';
    this.flushOnChainEnd = flushOnChainEnd;
    if (this.nonLlmMode === 'legacy_all') warnLegacyToolTrackingOnce();
    if (apiKey !== undefined && this.nonLlmMode === 'policy') {
      void ensureNonLlmPolicy().catch(() => {
        /* R1 */
      });
    }
    // A terminal callback without a matching start belongs, at best, to the
    // identity under which this handler was created. Real starts capture the
    // current generation separately, so a reused handler still works after a
    // deliberate reinit while orphaned old callbacks remain fenced out.
    this.fallbackGeneration = getConfigGeneration();
  }

  // LangChain.js v1 managers pass parentRunId before tags/metadata. LLM and
  // chat starts additionally pass extraParams between parentRunId and tags.
  handleChainStart(
    chain: unknown,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: JsonishRecord,
    _runType?: string,
    runName?: string,
    extra?: JsonishRecord,
  ): void {
    this.handleStart({
      runId,
      parentRunId,
      serialized: chain,
      metadata,
      kind: 'chain',
      name: runName,
      extraParams: extra,
    });
  }

  handleLLMStart(
    llm: unknown,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: JsonishRecord,
    _tags?: string[],
    metadata?: JsonishRecord,
    runName?: string,
  ): void {
    if (this.llmTracking === 'off') return;
    this.handleStart({
      runId,
      parentRunId,
      serialized: llm,
      metadata,
      kind: 'llm',
      name: runName,
      extraParams,
    });
  }

  handleChatModelStart(
    llm: unknown,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
    extraParams?: JsonishRecord,
    _tags?: string[],
    metadata?: JsonishRecord,
    runName?: string,
  ): void {
    if (this.llmTracking === 'off') return;
    this.handleStart({
      runId,
      parentRunId,
      serialized: llm,
      metadata,
      kind: 'llm',
      name: runName,
      extraParams,
    });
  }

  handleLLMEnd(output: unknown, runId: string, parentRunId?: string): void {
    if (this.llmTracking === 'off') return;
    try {
      const runKey = id(runId);
      if (!runKey) return;
      const parentRunKey = id(parentRunId);
      const state = this.takeTerminalState({ runKey, parentRunKey, kind: 'llm' });
      if (!state) return;
      if (this.callbackLlmIsWrapperOwned(state)) return;

      const usage = extractUsage(output);
      const metadata = { ...state.metadata };
      if (usage.found) metadata['token_count_source'] = TokenCountSource.EXACT;
      else metadata['usage_missing'] = true;

      enqueue(
        this.eventFromState(state, {
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          status: EventStatus.SUCCESS,
          model: usage.model ?? state.model,
          provider: usage.provider ?? state.provider,
          metadata,
        }),
      );
    } catch {
      /* R1 */
    }
  }

  handleLLMError(error: unknown, runId: string, parentRunId?: string): void {
    if (this.llmTracking === 'off') return;
    try {
      const runKey = id(runId);
      if (!runKey) return;
      const parentRunKey = id(parentRunId);
      const state = this.takeTerminalState({ runKey, parentRunKey, kind: 'llm' });
      if (!state) return;
      if (this.callbackLlmIsWrapperOwned(state)) return;
      const errorName =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name?: unknown }).name)
          : 'Error';

      enqueue(
        this.eventFromState(state, {
          tokensIn: 0,
          tokensOut: 0,
          status: EventStatus.FAILURE,
          model: state.model,
          provider: state.provider,
          metadata: { ...state.metadata, error_type: cleanStep(errorName) ?? 'Error' },
        }),
      );
    } catch {
      /* R1 */
    }
  }

  async handleChainError(_error: unknown, runId: string): Promise<void> {
    let ownerGeneration: number | null = getConfigGeneration();
    try {
      const runKey = id(runId);
      if (runKey) {
        ownerGeneration = this.takeTerminalGeneration(runKey);
      }
    } catch {
      /* R1 */
    }
    if (
      this.flushOnChainEnd &&
      ownerGeneration !== null &&
      ownerGeneration === getConfigGeneration()
    ) {
      try {
        await flush();
      } catch {
        /* R1 */
      }
    }
  }

  handleToolStart(
    tool: unknown,
    _input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: JsonishRecord,
    runName?: string,
  ): void {
    if (!this.observeToolCalls) return;
    if (this.nonLlmMode === 'policy') {
      void ensureNonLlmPolicy().catch(() => {
        /* R1 */
      });
    }
    this.handleStart({
      runId,
      parentRunId,
      serialized: tool,
      metadata,
      kind: 'tool',
      name: runName,
      extraParams: undefined,
      toolInput: _input,
    });
  }

  handleToolEnd(output: unknown, runId: string, parentRunId?: string): void {
    if (!this.observeToolCalls) return;
    try {
      const runKey = id(runId);
      if (!runKey) return;
      const parentRunKey = id(parentRunId);
      const state = this.takeTerminalState({ runKey, parentRunKey, kind: 'tool' });
      if (!state) return;
      if (this.callbackToolIsWrapperOwned(state)) return;
      const toolName = cleanStep(state.run_name ?? state.step_name ?? 'tool') ?? 'tool';
      if (this.nonLlmMode === 'policy') {
        this.handlePolicyTool({
          state,
          toolName,
          status: EventStatus.SUCCESS,
          output,
        });
        return;
      }
      const event = this.eventFromState(state, {
        tokensIn: 0,
        tokensOut: 0,
        status: EventStatus.SUCCESS,
        model: null,
        provider: null,
        metadata: state.metadata,
      });

      enqueue({
        ...event,
        provider: null,
        tool_name: toolName,
        instrumentation_tier: InstrumentationTier.REPORTED,
        cost_source: CostSource.CONFIGURED,
        metric: 'calls',
        metric_value: 1,
      });
    } catch {
      /* R1 */
    }
  }

  handleToolError(error: unknown, runId: string, parentRunId?: string): void {
    if (!this.observeToolCalls) return;
    try {
      const runKey = id(runId);
      if (!runKey) return;
      const parentRunKey = id(parentRunId);
      const state = this.takeTerminalState({ runKey, parentRunKey, kind: 'tool' });
      if (!state) return;
      if (this.callbackToolIsWrapperOwned(state)) return;
      const toolName = cleanStep(state.run_name ?? state.step_name ?? 'tool') ?? 'tool';
      const errorName =
        typeof error === 'object' && error !== null && 'name' in error
          ? String((error as { name?: unknown }).name)
          : 'Error';
      if (this.nonLlmMode === 'policy') {
        this.handlePolicyTool({
          state,
          toolName,
          status: EventStatus.FAILURE,
          metadata: { ...state.metadata, error_type: cleanStep(errorName) ?? 'Error' },
        });
        return;
      }
      const event = this.eventFromState(state, {
        tokensIn: 0,
        tokensOut: 0,
        status: EventStatus.FAILURE,
        model: null,
        provider: null,
        metadata: { ...state.metadata, error_type: cleanStep(errorName) ?? 'Error' },
      });

      enqueue({
        ...event,
        provider: null,
        tool_name: toolName,
        instrumentation_tier: InstrumentationTier.REPORTED,
        cost_source: CostSource.CONFIGURED,
        metric: 'calls',
        metric_value: 1,
      });
    } catch {
      /* R1 */
    }
  }

  async handleChainEnd(_outputs: unknown, runId: string): Promise<void> {
    let ownerGeneration: number | null = getConfigGeneration();
    try {
      const runKey = id(runId);
      if (runKey) {
        ownerGeneration = this.takeTerminalGeneration(runKey);
      }
    } catch {
      /* R1 */
    }
    if (
      this.flushOnChainEnd &&
      ownerGeneration !== null &&
      ownerGeneration === getConfigGeneration()
    ) {
      try {
        await flush();
      } catch {
        /* R1 */
      }
    }
  }

  copy(): PylvaCallbackHandler {
    return this;
  }

  private handleStart(input: {
    runId: unknown;
    parentRunId: unknown;
    serialized: unknown;
    metadata: JsonishRecord | undefined;
    kind: RunKind;
    name: string | undefined;
    extraParams: JsonishRecord | undefined;
    toolInput?: unknown;
  }): void {
    try {
      const runKey = id(input.runId);
      if (!runKey) return;
      const generation = getConfigGeneration();
      this.completedRuns.delete(runKey);
      completeControlledCallback(this.runs.get(runKey)?.controlled_callback ?? null);
      const parentRunKey = id(input.parentRunId);
      const parentCandidate = parentRunKey ? this.runs.get(parentRunKey) : undefined;
      const parent = parentCandidate?.generation === generation ? parentCandidate : undefined;
      const ctx = currentContext();
      const safeMetadata = safeRunMetadata(input.metadata);
      const runName = resolveRunName(input.serialized, input.name);
      const runUuid = uuidOrRandom(runKey);
      const parentUuid = parent?.run_id ?? uuidOrNull(parentRunKey);
      const traceId = parent?.trace_id ?? ctx?.trace_id ?? parentUuid ?? runUuid;
      const controlledOperation =
        input.kind === 'llm' || input.kind === 'tool'
          ? controlledOperationForCallbackStart(input.kind)
          : null;
      const controlledCallback =
        controlledOperation === null && (input.kind === 'llm' || input.kind === 'tool')
          ? registerControlledCallback(input.kind)
          : null;

      this.runs.set(runKey, {
        generation,
        runKey,
        parentRunKey,
        run_id: runUuid,
        parent_run_id: parentUuid,
        trace_id: traceId,
        customer_id: this.resolveCustomerId(safeMetadata),
        step_name: resolveStepName(safeMetadata, runName),
        provider: resolveProvider(input.serialized, safeMetadata, input.extraParams),
        model: resolveModel(input.serialized, safeMetadata, input.extraParams),
        run_name: runName,
        started_at: Date.now(),
        metadata: safeMetadata,
        kind: input.kind,
        controlled_operation: controlledOperation,
        controlled_callback: controlledCallback,
        tool_input: input.toolInput,
      });
    } catch {
      /* R1 */
    }
  }

  private fallbackState(input: {
    runKey: string;
    parentRunKey: string | null;
    kind: RunKind;
  }): RunState {
    const ctx = currentContext();
    const runUuid = uuidOrRandom(input.runKey);
    const parentUuid = uuidOrNull(input.parentRunKey);
    return {
      generation: this.fallbackGeneration,
      runKey: input.runKey,
      parentRunKey: input.parentRunKey,
      run_id: runUuid,
      parent_run_id: parentUuid,
      trace_id: ctx?.trace_id ?? parentUuid ?? runUuid,
      customer_id: this.customerId ?? cleanCustomerId(ctx?.customer_id) ?? 'anonymous',
      step_name: cleanStep(ctx?.step_name),
      provider: null,
      model: null,
      run_name: null,
      started_at: Date.now(),
      metadata: {},
      kind: input.kind,
      controlled_operation: null,
      controlled_callback: null,
    };
  }

  private callbackLlmIsWrapperOwned(state: RunState): boolean {
    const operation =
      state.controlled_operation ?? state.controlled_callback?.controlledOperation ?? null;
    const noDispatch = state.controlled_callback?.controlledNoDispatch ?? null;
    return this.llmTracking === 'auto' && (operation?.kind === 'llm' || noDispatch?.kind === 'llm');
  }

  private callbackToolIsWrapperOwned(state: RunState): boolean {
    const operation =
      state.controlled_operation ?? state.controlled_callback?.controlledOperation ?? null;
    const noDispatch = state.controlled_callback?.controlledNoDispatch ?? null;
    return operation?.kind === 'tool' || noDispatch?.kind === 'tool';
  }

  private takeTerminalGeneration(runKey: string): number | null {
    const state = this.runs.get(runKey);
    if (state) {
      this.runs.delete(runKey);
      completeControlledCallback(state.controlled_callback);
      this.rememberCompletedRun(runKey, state.generation);
      return state.generation;
    }
    if (this.completedRuns.has(runKey)) return null;
    const generation = this.fallbackGeneration;
    this.rememberCompletedRun(runKey, generation);
    return generation;
  }

  private takeTerminalState(input: {
    runKey: string;
    parentRunKey: string | null;
    kind: RunKind;
  }): RunState | null {
    const state = this.runs.get(input.runKey);
    if (state) {
      this.runs.delete(input.runKey);
      completeControlledCallback(state.controlled_callback);
      this.rememberCompletedRun(input.runKey, state.generation);
      return state.generation === getConfigGeneration() ? state : null;
    }
    if (this.completedRuns.has(input.runKey)) return null;
    const fallback = this.fallbackState(input);
    this.rememberCompletedRun(input.runKey, fallback.generation);
    return fallback.generation === getConfigGeneration() ? fallback : null;
  }

  private rememberCompletedRun(runKey: string, generation: number): void {
    // Refresh insertion order when a real run ID is intentionally reused.
    this.completedRuns.delete(runKey);
    this.completedRuns.set(runKey, generation);
    if (this.completedRuns.size <= MAX_COMPLETED_RUN_TOMBSTONES) return;
    const oldest = this.completedRuns.keys().next().value;
    if (oldest !== undefined) this.completedRuns.delete(oldest);
  }

  private handlePolicyTool(input: {
    state: RunState;
    toolName: string;
    status: EventStatus;
    output?: unknown;
    metadata?: JsonishRecord;
  }): void {
    void ensureNonLlmPolicy().catch(() => {
      /* R1 */
    });
    const metadata = input.metadata ?? input.state.metadata;
    const candidates = [
      input.toolName,
      input.state.run_name,
      input.state.step_name,
      metadata['pylva_tool'],
      metadata['tool_name'],
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const decision = decideNonLlmTool(candidates);
    if (decision.kind === 'ignored') return;
    if (decision.kind === 'unknown') {
      recordNonLlmDiscovery({
        toolName: input.toolName,
        matcher: decision.matcher,
        stepName: input.state.step_name,
        framework: Framework.LANGGRAPH,
        status: input.status,
      });
      return;
    }
    if (!decision.source.metric) return;
    const customerId = cleanCustomerId(input.state.customer_id) ?? 'anonymous';
    const value = metricValueForSource(
      decision.source,
      {
        toolName: input.toolName,
        matcher: decision.matcher,
        customerId,
        stepName: input.state.step_name,
        status: input.status,
        framework: Framework.LANGGRAPH,
        input: input.state.tool_input,
        output: input.output,
        metadata,
      },
      this.nonLlmConfig?.usageExtractors,
    );
    if (value === null) return;

    const event = this.eventFromState(input.state, {
      tokensIn: 0,
      tokensOut: 0,
      status: input.status,
      model: null,
      provider: null,
      metadata,
    });
    enqueue({
      ...event,
      provider: null,
      tool_name: input.toolName,
      instrumentation_tier: InstrumentationTier.REPORTED,
      cost_source: CostSource.CONFIGURED,
      metric: decision.source.metric,
      metric_value: value,
    });
  }

  private resolveCustomerId(metadata: JsonishRecord): string {
    if (this.customerId) return this.customerId;
    for (const key of ['pylva_customer_id', 'customer_id']) {
      const value = cleanCustomerId(metadata[key]);
      if (value) return value;
    }
    const ctx = currentContext();
    return cleanCustomerId(ctx?.customer_id) ?? 'anonymous';
  }

  private eventFromState(
    state: RunState,
    input: {
      tokensIn: number;
      tokensOut: number;
      status: EventStatus;
      model: string | null;
      provider: Provider | null;
      metadata: JsonishRecord;
    },
  ): Omit<TelemetryEvent, 'schema_version' | 'sdk_version'> {
    return {
      run_id: state.run_id,
      parent_run_id: state.parent_run_id,
      trace_id: state.trace_id,
      span_id: state.run_id,
      parent_span_id: state.parent_run_id,
      customer_id: cleanCustomerId(state.customer_id) ?? 'anonymous',
      step_name: cleanStep(state.step_name),
      model: cleanModel(input.model),
      provider: input.provider ?? Provider.OTHER,
      tokens_in: nonNegativeInt(input.tokensIn),
      tokens_out: nonNegativeInt(input.tokensOut),
      latency_ms: Math.max(0, Date.now() - state.started_at),
      tool_name: null,
      status: input.status,
      framework: Framework.LANGGRAPH,
      instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
      cost_source: CostSource.AUTO,
      metric: null,
      metric_value: null,
      stream_aborted: false,
      abort_savings_usd: 0,
      timestamp: new Date().toISOString(),
      metadata: safeEventMetadata(input.metadata),
    };
  }
}

// LangChain.js uses one callback protocol for sync and async runs. This alias
// mirrors the Python SDK's public import for users looking for parity.
export class AsyncPylvaCallbackHandler extends PylvaCallbackHandler {}

Object.defineProperty(PylvaCallbackHandler, 'name', { value: 'PylvaCallbackHandler' });
Object.defineProperty(AsyncPylvaCallbackHandler, 'name', { value: 'AsyncPylvaCallbackHandler' });

function parseLlmTrackingMode(value: unknown): PylvaCallbackLlmTrackingMode {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'callback' || value === 'off') return value;
  throw new TypeError("[pylva] llmTracking must be 'auto', 'callback', or 'off'");
}

function parseOptionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw new TypeError(`[pylva] ${label} must be a boolean`);
}

function id(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null): string | null {
  if (!value) return null;
  return UUID_RE.test(value) ? value : null;
}

function uuidOrRandom(value: string | null): string {
  return uuidOrNull(value) ?? randomUUID();
}

function isRecord(value: unknown): value is JsonishRecord {
  return typeof value === 'object' && value !== null;
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

const CUSTOMER_RE = /^[a-zA-Z0-9_-]{1,255}$/;
const STEP_RE = /[^a-zA-Z0-9 _\-.:/]/g;
const METADATA_STEP_LABEL_RE = /^[A-Za-z0-9_.:/-]{1,100}$/;
const PROVIDER_MODEL_MAX_LENGTH = 255;
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/;

function cleanCustomerId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return CUSTOMER_RE.test(value) ? value : null;
}

function cleanStep(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const cleaned = value.replace(STEP_RE, '_').slice(0, 200).trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanMetadataStepLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.trim() !== value) return null;
  return METADATA_STEP_LABEL_RE.test(value) ? value : null;
}

function cleanProviderModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > PROVIDER_MODEL_MAX_LENGTH) return null;
  if (value.trim().length === 0) return null;
  if (CONTROL_CHARACTER_RE.test(value)) return null;
  return value;
}

function cleanModel(value: unknown): string | null {
  return cleanProviderModel(value);
}

function cleanProvider(value: unknown): Provider | null {
  return cleanProviderModel(value);
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeRunMetadata(metadata: JsonishRecord | undefined): JsonishRecord {
  if (!isRecord(metadata)) return {};
  const out: JsonishRecord = {};
  for (const key of ['pylva_customer_id', 'customer_id']) {
    const value = cleanCustomerId(metadata[key]);
    if (value) out[key] = value;
  }
  for (const key of ['langgraph_node', 'langgraph_step', 'pylva_step', 'pylva_tool', 'tool_name']) {
    const value = cleanMetadataStepLabel(metadata[key]);
    if (value) out[key] = value;
  }
  const provider = cleanProvider(metadata['ls_provider']);
  if (provider) out['ls_provider'] = provider;
  const model = cleanModel(metadata['ls_model_name']);
  if (model) out['ls_model_name'] = model;
  return out;
}

function safeEventMetadata(metadata: JsonishRecord): JsonishRecord {
  const out: JsonishRecord = {};
  for (const key of ['langgraph_node', 'langgraph_step', 'pylva_step', 'pylva_tool', 'tool_name']) {
    const value = cleanMetadataStepLabel(metadata[key]);
    if (value) out[key] = value;
  }
  const provider = cleanProvider(metadata['ls_provider']);
  if (provider) out['ls_provider'] = provider;
  const model = cleanModel(metadata['ls_model_name']);
  if (model) out['ls_model_name'] = model;
  if (metadata['token_count_source'] === TokenCountSource.EXACT) {
    out['token_count_source'] = TokenCountSource.EXACT;
  }
  if (metadata['usage_missing'] === true) out['usage_missing'] = true;
  const errorType = cleanStep(metadata['error_type']);
  if (errorType) out['error_type'] = errorType;
  return out;
}

function resolveRunName(serialized: unknown, name: unknown): string | null {
  const named = cleanStep(name);
  if (named) return named;
  const serializedName = cleanStep(recordValue(serialized, 'name'));
  if (serializedName) return serializedName;
  const serializedId = recordValue(serialized, 'id');
  if (Array.isArray(serializedId) && serializedId.length > 0) {
    return cleanStep(serializedId.at(-1));
  }
  return null;
}

function resolveStepName(metadata: JsonishRecord, runName: string | null): string | null {
  return cleanStep(
    firstString(
      metadata['langgraph_node'],
      metadata['pylva_step'],
      metadata['langgraph_step'],
      runName,
    ),
  );
}

function invocationParams(extraParams: JsonishRecord | undefined): unknown {
  if (!extraParams) return {};
  return (
    recordValue(extraParams, 'invocation_params') ??
    recordValue(extraParams, 'invocationParams') ??
    extraParams
  );
}

function resolveProvider(
  serialized: unknown,
  metadata: JsonishRecord,
  extraParams: JsonishRecord | undefined,
): Provider | null {
  const invocation = invocationParams(extraParams);
  return cleanProvider(
    firstString(
      metadata['ls_provider'],
      recordValue(invocation, 'provider'),
      recordValue(invocation, 'model_provider'),
      recordValue(invocation, 'modelProvider'),
      recordValue(serialized, 'provider'),
      recordValue(serialized, 'name'),
    ),
  );
}

function resolveModel(
  serialized: unknown,
  metadata: JsonishRecord,
  extraParams: JsonishRecord | undefined,
): string | null {
  const invocation = invocationParams(extraParams);
  return cleanModel(
    firstString(
      metadata['ls_model_name'],
      recordValue(invocation, 'model'),
      recordValue(invocation, 'model_name'),
      recordValue(invocation, 'modelName'),
      recordValue(serialized, 'model'),
      recordValue(serialized, 'model_name'),
      recordValue(serialized, 'modelName'),
    ),
  );
}

function extractUsage(output: unknown): UsageResult {
  const generation = firstGeneration(output);
  const message = recordValue(generation, 'message') ?? generation;
  const usageMetadata =
    recordValue(message, 'usage_metadata') ?? recordValue(message, 'usageMetadata');
  const model = modelFromMessage(message);
  const provider = providerFromMessage(message);

  const messageUsage = usageFromShape(usageMetadata, model, provider);
  if (messageUsage.found) return messageUsage;

  const llmOutput = recordValue(output, 'llmOutput') ?? recordValue(output, 'llm_output');
  const tokenUsage =
    recordValue(llmOutput, 'tokenUsage') ??
    recordValue(llmOutput, 'token_usage') ??
    recordValue(llmOutput, 'usage');
  const llmUsage = usageFromShape(
    tokenUsage,
    model ??
      cleanModel(
        firstString(recordValue(llmOutput, 'model_name'), recordValue(llmOutput, 'model')),
      ),
    providerFromRecord(llmOutput) ?? provider,
  );
  if (llmUsage.found) return llmUsage;

  return { tokensIn: 0, tokensOut: 0, model, provider, found: false };
}

function firstGeneration(output: unknown): unknown {
  const generations = recordValue(output, 'generations');
  if (!Array.isArray(generations) || generations.length === 0) return null;
  const firstRow = generations[0];
  if (Array.isArray(firstRow)) return firstRow[0] ?? null;
  return firstRow;
}

function usageFromShape(
  usage: unknown,
  model: string | null,
  provider: Provider | null,
): UsageResult {
  const tokensIn = usageInt(usage, 'input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens');
  const tokensOut = usageInt(
    usage,
    'output_tokens',
    'completion_tokens',
    'outputTokens',
    'completionTokens',
  );
  const total = usageInt(usage, 'total_tokens', 'totalTokens');
  if (tokensIn !== null || tokensOut !== null || total !== null) {
    const resolvedIn = tokensIn ?? 0;
    return {
      tokensIn: resolvedIn,
      tokensOut: tokensOut ?? Math.max((total ?? 0) - resolvedIn, 0),
      model,
      provider,
      found: true,
    };
  }
  return { tokensIn: 0, tokensOut: 0, model, provider, found: false };
}

function usageInt(usage: unknown, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = recordValue(usage, key);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return null;
}

function modelFromMessage(message: unknown): string | null {
  const responseMetadata =
    recordValue(message, 'response_metadata') ?? recordValue(message, 'responseMetadata');
  return cleanModel(
    firstString(
      recordValue(responseMetadata, 'model_name'),
      recordValue(responseMetadata, 'modelName'),
      recordValue(responseMetadata, 'model'),
      recordValue(message, 'model'),
    ),
  );
}

function providerFromMessage(message: unknown): Provider | null {
  const responseMetadata =
    recordValue(message, 'response_metadata') ?? recordValue(message, 'responseMetadata');
  return providerFromRecord(responseMetadata);
}

function providerFromRecord(record: unknown): Provider | null {
  const raw = firstString(
    recordValue(record, 'provider'),
    recordValue(record, 'model_provider'),
    recordValue(record, 'modelProvider'),
  );
  return cleanProvider(raw);
}
