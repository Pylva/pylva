import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  Pylva,
  PylvaBudgetExceeded,
  PylvaControlApiError,
  PylvaControlUnavailableError,
  PylvaControlValidationError,
  PylvaStrictProviderError,
  commitUsage,
  controlStatus,
  controlledExactUsage,
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
  controlledTavilySearch,
  controlledUsage,
  currentControlledAttempt,
  extendUsage,
  ready,
  releaseUsage,
  reserveUsage,
  shouldSuppressLegacyTelemetry,
  wrapAnthropic,
  wrapOpenAI,
  type ControlConfig,
  type ControlReadyResult,
  type CommitUsageResult,
  type ControlledAnthropicClient,
  type ControlledOpenAIClient,
  type ControlledOpenAIChatModel,
  type ControlledOpenAIChatModelOptions,
  type ControlledUsageResult,
  type ExtendUsageResult,
  type ReleaseUsageResult,
  type ResolvedConfig,
  type ReserveUsageInput,
  type StrictAnthropicOptions,
  type StrictOpenAIOptions,
} from '../src/index.js';

const llm: ReserveUsageInput = {
  kind: 'llm',
  operationId: '11111111-1111-4111-8111-111111111111',
  customerId: 'customer',
  traceId: '22222222-2222-4222-8222-222222222222',
  spanId: '33333333-3333-4333-8333-333333333333',
  parentSpanId: null,
  provider: 'openai',
  model: 'gpt-4.1',
  estimatedInputTokens: 1,
  maxOutputTokens: 2,
};

const tool: ReserveUsageInput = {
  kind: 'tool',
  operationId: '11111111-1111-4111-8111-111111111111',
  customerId: 'customer',
  traceId: '22222222-2222-4222-8222-222222222222',
  spanId: '33333333-3333-4333-8333-333333333333',
  parentSpanId: null,
  costSourceSlug: 'web-search',
  toolName: 'web.search',
  metric: 'queries',
  maximumValue: '0.125',
};

void reserveUsage(llm);
void reserveUsage(tool);
const reservationId = '44444444-4444-4444-8444-444444444444';
const extensionId = '55555555-5555-4555-8555-555555555555';
const committed: Promise<CommitUsageResult> = commitUsage({
  reservationId,
  kind: 'llm',
  status: 'success',
  latencyMs: 25,
  streamAborted: false,
  actualInputTokens: 1,
  actualOutputTokens: 2,
});
const released: Promise<ReleaseUsageResult> = releaseUsage({
  reservationId,
  reason: 'provider_not_called',
});
const extended: Promise<ExtendUsageResult> = extendUsage({
  reservationId,
  extensionId,
  extendBySeconds: 300,
});
void committed;
void released;
void extended;
const readyResult: Promise<boolean> = ready();
const statusResult: Promise<ControlReadyResult> = controlStatus();
void readyResult;
void statusResult;

declare const facadeInput: ReserveUsageInput;
// @ts-expect-error Public request fields are camelCase, never wire snake_case.
facadeInput.operation_id;

declare const result: Awaited<ReturnType<typeof reserveUsage>>;
type NoFulfilledDenial =
  Extract<typeof result, { decision: 'denied' }> extends never ? true : false;
const noFulfilledDenial: NoFulfilledDenial = true;
void noFulfilledDenial;
if (result.decision === 'reserved') {
  result.reservationId;
  const suppress: boolean = shouldSuppressLegacyTelemetry(result, {
    operationId: result.operationId,
    reservationId: result.reservationId,
  });
  void suppress;
  // @ts-expect-error Public response fields are camelCase, never wire snake_case.
  result.reservation_id;
}

const control: ControlConfig = { mode: 'enforce', onUnavailable: 'deny', timeoutMs: 2_000 };
void control;
// @ts-expect-error Unknown modes are rejected at compile time and runtime.
const badControl: ControlConfig = { mode: 'blocking' };
void badControl;

// ResolvedConfig was public in 1.1. Keep its credential-bearing declaration
// source-compatible even though the internal runtime now uses a redacted type.
const legacyResolvedConfig: ResolvedConfig = {
  apiKey: `pv_live_12345678_${'a'.repeat(32)}`,
  endpoint: 'https://api.pylva.com',
  batchSize: 100,
  flushInterval: 5_000,
  localMode: false,
};
const legacyResolvedApiKey: string = legacyResolvedConfig.apiKey;
legacyResolvedConfig.control = { mode: 'enforce', onUnavailable: 'deny', timeoutMs: 2_000 };
void legacyResolvedApiKey;

declare const pylva: Pylva;
const pylvaReady: Promise<boolean> = pylva.ready();
const pylvaStatus: Promise<ControlReadyResult> = pylva.controlStatus();
void pylvaReady;
void pylvaStatus;
void pylva.reserveUsage(llm);
const pylvaCommitted: Promise<CommitUsageResult> = pylva.commitUsage({
  reservationId,
  kind: 'tool',
  status: 'success',
  latencyMs: 10,
  streamAborted: false,
  actualValue: '1',
});
const pylvaReleased: Promise<ReleaseUsageResult> = pylva.releaseUsage({
  reservationId,
  reason: 'provider_not_called',
});
const pylvaExtended: Promise<ExtendUsageResult> = pylva.extendUsage({
  reservationId,
  extensionId,
  extendBySeconds: 300,
});
void pylvaCommitted;
void pylvaReleased;
void pylvaExtended;

declare const openAiClient: { chat: unknown };
declare const anthropicClient: { messages: unknown };
const strictOptions: StrictOpenAIOptions & StrictAnthropicOptions = {
  reservationTtlSeconds: 300,
  heartbeatIntervalMs: 1_000,
  heartbeatExtendBySeconds: 300,
};
void wrapOpenAI(openAiClient, strictOptions);
void wrapAnthropic(anthropicClient, strictOptions);

async function controlledProviderSurfaceTypes(openAi: OpenAI, anthropic: Anthropic): Promise<void> {
  const openAiPromise = wrapOpenAI(openAi, strictOptions);
  // @ts-expect-error The official private client is initialized asynchronously.
  const synchronousOpenAI: ControlledOpenAIClient<OpenAI> = openAiPromise;
  void synchronousOpenAI;
  const controlledOpenAI: ControlledOpenAIClient<OpenAI> = await openAiPromise;
  controlledOpenAI.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello' }],
    max_completion_tokens: 10,
  });
  controlledOpenAI.close();
  // @ts-expect-error Responses is outside the explicitly priced facade.
  controlledOpenAI.responses;
  // @ts-expect-error Only Chat Completions create is exposed.
  controlledOpenAI.chat.completions.parse;
  // @ts-expect-error Retry posture is immutable and always zero.
  controlledOpenAI.maxRetries = 1;

  const controlledAnthropic: ControlledAnthropicClient<Anthropic> = await wrapAnthropic(
    anthropic,
    strictOptions,
  );
  controlledAnthropic.messages.create({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 10,
  });
  controlledAnthropic.messages.stream({
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 10,
  });
  controlledAnthropic.close();
  // @ts-expect-error Legacy completions is outside the priced facade.
  controlledAnthropic.completions;
  // @ts-expect-error Only create and stream are exposed on Messages.
  controlledAnthropic.messages.batches;
}
void controlledProviderSurfaceTypes;

const generated: Promise<unknown> = controlledGenerateText({});
const streamed: Promise<unknown> = controlledStreamText({});
const controlledModelOptions: ControlledOpenAIChatModelOptions = {
  apiKey: 'provider-key',
  model: 'gpt-4o-mini',
};
const controlledModel: Promise<ControlledOpenAIChatModel> =
  createControlledOpenAIChatModel(controlledModelOptions);
void generated;
void streamed;
void controlledModel;
// @ts-expect-error The controlled model factory accepts only API key and model.
createControlledOpenAIChatModel({ apiKey: 'provider-key', model: 'gpt-4o-mini', baseURL: 'x' });

const controlledTool: Promise<ControlledUsageResult<{ count: number }>> = controlledUsage({
  costSourceSlug: 'search',
  toolName: 'Search',
  metric: 'query',
  maximumValue: 2,
  invoke: async () => ({ count: 1 }),
  extractActual: (value) => value.count,
  customerId: 'customer',
});
const controlledExact: Promise<ControlledUsageResult<string>> = controlledExactUsage({
  costSourceSlug: 'email',
  toolName: 'Email',
  metric: 'message',
  value: '1',
  invoke: async () => 'sent',
  customerId: 'customer',
});
const controlledTavily: Promise<ControlledUsageResult<{ usage: { credits: number } }>> =
  controlledTavilySearch(
    { search: async () => ({ usage: { credits: 1 } }) },
    { query: 'query', customerId: 'customer' },
  );
void controlledTool;
void controlledExact;
void controlledTavily;

const activeAttempt = currentControlledAttempt();
if (activeAttempt) {
  activeAttempt.operationId;
  activeAttempt.ownsReservation;
  activeAttempt.legacyTelemetryRequired;
}

declare const strictProviderError: PylvaStrictProviderError;
strictProviderError.provider;
strictProviderError.reason;

const budgetError: PylvaBudgetExceeded = new PylvaBudgetExceeded({
  source: 'authoritative_control',
  rule_id: 'rule-id',
  customer_id: 'customer',
  period: 'day',
  period_start: '2026-07-14T00:00:00.000Z',
  limit_usd: 1,
  accumulated_usd: 1,
  estimated_usd: 0.1,
});
const unavailableError: PylvaControlUnavailableError = new PylvaControlUnavailableError({
  reason: 'network_error',
  retryable: true,
  operation: 'reserveUsage',
});
const apiError: PylvaControlApiError = new PylvaControlApiError(409, 'operation_conflict');
const validationError: PylvaControlValidationError = new PylvaControlValidationError(
  'reserveUsage',
);
class CustomUnavailableError extends PylvaControlUnavailableError {}
const customUnavailable: PylvaControlUnavailableError = new CustomUnavailableError({
  reason: 'network_error',
  retryable: true,
  operation: 'ready',
});
const constructorNames: string[] = [
  PylvaBudgetExceeded.name,
  PylvaControlUnavailableError.name,
  PylvaControlApiError.name,
  PylvaControlValidationError.name,
  PylvaStrictProviderError.name,
];
void budgetError;
void unavailableError;
void apiError;
void validationError;
void customUnavailable;
void constructorNames;
