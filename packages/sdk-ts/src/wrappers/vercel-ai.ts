// Vercel AI SDK wrapper — patches generateText, streamText, generateObject.
// generateText/generateObject resolve `usage` to a value before returning, so
// telemetry is emitted inline. streamText returns synchronously; touching
// result.usage can consume the stream, so we emit telemetry from onFinish
// while preserving the host's synchronous stream result.
// R1 isolation preserved.
//
// D23 — this wrapper is intentionally thinner than openai/anthropic. It
// runs pre-call budget enforcement only; model routing and failover happen
// in the underlying provider's wrapper (vercel-ai composes over
// openai/anthropic SDKs, which are patched separately).
// Wiring runWithEngine here would double-apply routing decisions.

import { EventStatus, TokenCountSource } from '@pylva/shared/telemetry-values';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { types as nodeUtilTypes } from 'node:util';
import { enqueue } from '../core/telemetry.js';
import { getConfigGeneration, isInitialized } from '../core/config.js';
import { currentContext } from '../core/context.js';
import { PylvaBudgetExceeded } from '../errors/budget_exceeded.js';
import { PylvaStrictProviderError } from '../errors/strict_provider.js';
import { loadPeer } from './_load.js';
import { buildLlmEvent } from './_event.js';
import { maybeEnforcePreCall } from './_budget.js';
import {
  executeControlledAttempt,
  safeUint32,
  type ControlledAttemptHandle,
} from '../core/control_attempt.js';
import { linkLocalControlledCallbackNoDispatch } from '../core/control_correlation.js';
import { originalProviderMethod, registerPatchedOriginal } from './_strict_unwrap.js';

interface AiUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface AiResponse {
  usage?: AiUsage;
  modelId?: string;
}

type AiCallback = (event: unknown) => unknown;

interface AiRequest {
  model?: { modelId?: string; provider?: string };
  onFinish?: AiCallback;
  onError?: AiCallback;
  onAbort?: AiCallback;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function packageMajor(version: unknown): number | null {
  if (typeof version !== 'string') return null;
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isNaN(major) ? null : major;
}

function installedAiMajor(): number | null {
  const manifest = JSON.parse(
    readFileSync(createRequire(import.meta.url).resolve('ai/package.json'), 'utf8'),
  ) as unknown;
  return isPlainRecord(manifest) ? packageMajor(manifest['version']) : null;
}

const abortSignalPrototype = AbortSignal.prototype;
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  abortSignalPrototype,
  'aborted',
)?.get;
const abortSignalReasonGetter = Object.getOwnPropertyDescriptor(
  abortSignalPrototype,
  'reason',
)?.get;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;

function abortSignalValue(getter: (() => unknown) | undefined, signal: AbortSignal): unknown {
  return Reflect.apply(getter as () => unknown, signal, []);
}

function isControlledAbortSignal(value: unknown): value is AbortSignal {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== abortSignalPrototype ||
      Object.getOwnPropertyNames(value).length !== 0
    ) {
      return false;
    }
    abortSignalValue(abortSignalAbortedGetter, value as AbortSignal);
    return true;
  } catch {
    return false;
  }
}

function observeAbortSignal(signal: AbortSignal, observer: (reason: unknown) => void): () => void {
  const forward = () => observer(abortSignalValue(abortSignalReasonGetter, signal));
  if (abortSignalValue(abortSignalAbortedGetter, signal) === true) {
    forward();
    return () => {};
  }
  Reflect.apply(addEventListener, signal, ['abort', forward, { once: true }]);
  return () => Reflect.apply(removeEventListener, signal, ['abort', forward]);
}

let applied = false;

function isIntentionalRefusal(error: unknown): boolean {
  return error instanceof PylvaBudgetExceeded;
}

export function applyVercelAiPatch(): void {
  if (applied) return;
  const mod = loadPeer<Record<string, unknown>>('ai');
  if (!mod) return;

  wrapAsyncFn(mod, 'generateText');
  wrapStreamText(mod, aiSupportsStreamTerminalCallbacks());
  wrapAsyncFn(mod, 'generateObject');

  applied = true;
}

function wrapAsyncFn(mod: Record<string, unknown>, fnName: string): void {
  const original = mod[fnName];
  if (typeof original !== 'function') return;
  if ((original as { __pylva_patched?: boolean }).__pylva_patched) return;

  const wrapped = async function patched(this: unknown, ...args: unknown[]): Promise<unknown> {
    if (!isInitialized())
      return (original as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    const start = Date.now();
    const ownerGeneration = getConfigGeneration();
    const reqArg = getRequest(args);
    const providerRaw = reqArg?.model?.provider ?? null;
    const modelRaw = reqArg?.model?.modelId ?? null;

    try {
      maybeEnforcePreCall({
        // 'anonymous' matches telemetry attribution for untracked calls
        // (parity with buildEngineCtx).
        customer_id: currentContext()?.customer_id ?? 'anonymous',
        estimated_usd: 0,
      });
      const result = (await (original as (...a: unknown[]) => Promise<unknown>).apply(
        this,
        args,
      )) as AiResponse;
      emitSuccess(
        result?.modelId ?? modelRaw,
        result?.usage,
        providerRaw,
        start,
        fnName,
        ownerGeneration,
      );
      return result;
    } catch (err) {
      if (isIntentionalRefusal(err)) throw err;
      emitTerminal(EventStatus.FAILURE, modelRaw, providerRaw, start, fnName, ownerGeneration);
      throw err;
    }
  };

  (wrapped as unknown as { __pylva_patched: boolean }).__pylva_patched = true;
  registerPatchedOriginal(wrapped, original as (...args: unknown[]) => unknown);
  replaceExport(mod, fnName, wrapped);
}

function wrapStreamText(mod: Record<string, unknown>, supportsTerminalCallbacks: boolean): void {
  const original = mod['streamText'];
  if (typeof original !== 'function') return;
  if ((original as { __pylva_patched?: boolean }).__pylva_patched) return;

  const wrapped = function patched(this: unknown, ...args: unknown[]): unknown {
    if (!isInitialized()) return (original as (...a: unknown[]) => unknown).apply(this, args);
    const start = Date.now();
    const ownerGeneration = getConfigGeneration();
    const reqArg = getRequest(args);
    const providerRaw = reqArg?.model?.provider ?? null;
    const modelRaw = reqArg?.model?.modelId ?? null;
    let terminalEmitted = false;

    try {
      maybeEnforcePreCall({
        // 'anonymous' matches telemetry attribution for untracked calls
        // (parity with buildEngineCtx).
        customer_id: currentContext()?.customer_id ?? 'anonymous',
        estimated_usd: 0,
      });

      const streamArgs = reqArg
        ? [
            wrapStreamRequest(
              reqArg,
              providerRaw,
              modelRaw,
              start,
              ownerGeneration,
              supportsTerminalCallbacks,
              () => terminalEmitted,
              () => {
                terminalEmitted = true;
              },
            ),
            ...args.slice(1),
          ]
        : args;
      return (original as (...a: unknown[]) => unknown).apply(this, streamArgs);
    } catch (err) {
      if (isIntentionalRefusal(err)) throw err;
      if (!terminalEmitted) {
        terminalEmitted = true;
        emitTerminal(
          EventStatus.FAILURE,
          modelRaw,
          providerRaw,
          start,
          'streamText',
          ownerGeneration,
        );
      }
      throw err;
    }
  };

  (wrapped as unknown as { __pylva_patched: boolean }).__pylva_patched = true;
  registerPatchedOriginal(wrapped, original as (...args: unknown[]) => unknown);
  replaceExport(mod, 'streamText', wrapped);
}

function replaceExport(
  mod: Record<string, unknown>,
  fnName: string,
  wrapped: (...args: unknown[]) => unknown,
): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(mod, fnName);
  if (descriptor) {
    if ('value' in descriptor && descriptor.writable === false) return false;
    if (!('value' in descriptor) && typeof descriptor.set !== 'function') return false;
  }

  try {
    mod[fnName] = wrapped;
    return mod[fnName] === wrapped;
  } catch {
    return false;
  }
}

function wrapStreamRequest(
  reqArg: AiRequest,
  providerRaw: string | null,
  modelRaw: string | null,
  start: number,
  ownerGeneration: number,
  supportsTerminalCallbacks: boolean,
  getTerminalEmitted: () => boolean,
  setTerminalEmitted: () => void,
): AiRequest {
  const originalOnFinish = reqArg.onFinish;
  const originalOnError = reqArg.onError;
  const originalOnAbort = reqArg.onAbort;
  const wrapped: AiRequest = { ...reqArg };

  wrapped.onFinish = (event: unknown) => {
    if (!getTerminalEmitted()) {
      setTerminalEmitted();
      emitSuccess(
        modelFromFinishEvent(event, modelRaw),
        usageFromFinishEvent(event),
        providerRaw,
        start,
        'streamText',
        ownerGeneration,
      );
    }
    return originalOnFinish?.(event);
  };

  if (supportsTerminalCallbacks) {
    wrapped.onError = (event: unknown) => {
      if (!getTerminalEmitted()) {
        setTerminalEmitted();
        emitTerminal(
          EventStatus.FAILURE,
          modelRaw,
          providerRaw,
          start,
          'streamText',
          ownerGeneration,
        );
      }
      if (originalOnError) return originalOnError(event);
      // Provider/AI SDK error payloads can contain prompt or request details.
      // The wrapper records failure telemetry, but never logs raw host data.
      return undefined;
    };

    wrapped.onAbort = (event: unknown) => {
      if (!getTerminalEmitted()) {
        setTerminalEmitted();
        emitTerminal(
          EventStatus.ABORTED,
          modelRaw,
          providerRaw,
          start,
          'streamText',
          ownerGeneration,
        );
      }
      return originalOnAbort?.(event);
    };
  }

  return wrapped;
}

/** Emit a SUCCESS telemetry event from a (resolved) usage object. R1: never
 *  let a telemetry failure surface to the host. */
function emitSuccess(
  model: string | null,
  usage: AiUsage | undefined,
  providerRaw: string | null,
  start: number,
  fnName: string,
  ownerGeneration: number,
): void {
  if (ownerGeneration !== getConfigGeneration()) return;
  try {
    const extracted = extractUsage(usage);
    enqueue(
      buildLlmEvent({
        provider: providerRaw,
        model,
        tokensIn: extracted.tokensIn,
        tokensOut: extracted.tokensOut,
        latencyMs: Date.now() - start,
        status: EventStatus.SUCCESS,
        tokenCountSource: extracted.exact ? TokenCountSource.EXACT : TokenCountSource.ESTIMATED,
        stepNameFallback: fnName,
      }),
    );
  } catch (err) {
    console.warn(
      `[pylva] ai.${fnName} telemetry emit failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function emitTerminal(
  status: EventStatus,
  model: string | null,
  providerRaw: string | null,
  start: number,
  fnName: string,
  ownerGeneration: number,
): void {
  if (ownerGeneration !== getConfigGeneration()) return;
  try {
    enqueue(
      buildLlmEvent({
        provider: providerRaw,
        model,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - start,
        status,
        stepNameFallback: fnName,
      }),
    );
  } catch {
    // swallow
  }
}

function extractUsage(usage: AiUsage | undefined): {
  tokensIn: number;
  tokensOut: number;
  exact: boolean;
} {
  const tokensIn = readToken(usage?.promptTokens) ?? readToken(usage?.inputTokens);
  const tokensOut = readToken(usage?.completionTokens) ?? readToken(usage?.outputTokens);
  return {
    tokensIn: tokensIn ?? 0,
    tokensOut: tokensOut ?? 0,
    exact: tokensIn !== undefined && tokensOut !== undefined,
  };
}

function readToken(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getRequest(args: unknown[]): AiRequest | undefined {
  return isObject(args[0]) ? (args[0] as AiRequest) : undefined;
}

function usageFromFinishEvent(event: unknown): AiUsage | undefined {
  if (!isObject(event)) return undefined;
  return ((event['totalUsage'] ?? event['usage']) as AiUsage | undefined) ?? undefined;
}

function modelFromFinishEvent(event: unknown, fallback: string | null): string | null {
  if (!isObject(event)) return fallback;
  const response = event['response'];
  if (isObject(response) && typeof response['modelId'] === 'string') return response['modelId'];
  return fallback;
}

function aiSupportsStreamTerminalCallbacks(): boolean {
  try {
    const major = installedAiMajor();
    return major === null || major >= 5;
  } catch {
    return true;
  }
}

export function _resetVercelAiPatchForTests(): void {
  applied = false;
  officialOpenAiChatReference = undefined;
}

const CONTROLLED_AI_KEYS = new Set([
  'model',
  'system',
  'prompt',
  'messages',
  'maxOutputTokens',
  'maxRetries',
  'abortSignal',
  'timeout',
  'providerOptions',
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'seed',
  'onFinish',
  'onError',
  'onAbort',
  'onChunk',
]);

interface ControlledAiRequest extends Record<string, unknown> {
  model: object;
}

interface ControlledAiModelEvidence {
  provider: 'openai';
  model: string;
  lockedModel: object;
}

interface OfficialOpenAiChatReference {
  prototype: object;
  createOpenAI: (...args: unknown[]) => unknown;
  getArgs: (...args: unknown[]) => unknown;
  doGenerate: (...args: unknown[]) => unknown;
  doStream: (...args: unknown[]) => unknown;
}

let officialOpenAiChatReference: Promise<OfficialOpenAiChatReference | null> | undefined;

declare const controlledOpenAIChatModelBrand: unique symbol;

/** Opaque strict OpenAI Chat model created and owned by Pylva. */
export interface ControlledOpenAIChatModel {
  readonly [controlledOpenAIChatModelBrand]: true;
}

export interface ControlledOpenAIChatModelOptions {
  apiKey: string;
  model: string;
}

const controlledOpenAIChatModels = new WeakMap<object, ControlledAiModelEvidence>();
const controlledTextEncoder = new TextEncoder();

function controlledTextBytes(value: string): number {
  if (value.length > 1_000_000) {
    throw new PylvaStrictProviderError('openai', 'request_exceeds_local_complexity_limit');
  }
  return controlledTextEncoder.encode(JSON.stringify(value)).byteLength;
}

/** Exact bound for the validated text-only Vercel request shape. Source-test export only. */
export function _controlledAiInputBoundForTests(shape: {
  system: string | null;
  prompt: string | null;
  messages: Array<{ role: string; content: string }> | null;
}): number {
  let total =
    289 +
    (shape.system === null ? 4 : controlledTextBytes(shape.system)) +
    (shape.prompt === null ? 4 : controlledTextBytes(shape.prompt));
  const messages = shape.messages;
  if (messages === null) return total + 4;
  if (messages.length > 33_332) {
    throw new PylvaStrictProviderError('openai', 'request_exceeds_local_complexity_limit');
  }
  total += Math.max(2, messages.length + 1);
  for (const message of messages) {
    total += 20 + controlledTextBytes(message.role) + controlledTextBytes(message.content);
  }
  return Math.min(total, 4_294_967_295);
}

function refuseControlledAi(reason: string, local = true): never {
  if (local) linkLocalControlledCallbackNoDispatch('llm');
  throw new PylvaStrictProviderError('vercel-ai', reason);
}

function detachedRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)) return null;
  try {
    if (!isPlainRecord(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length > 256 || keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function detachedArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 100_000) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key === 'symbol'))
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    return null;
  }
}

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OFFICIAL_OPENAI_CONFIG_KEYS = new Set(['provider', 'url', 'headers', 'fetch']);

async function loadOfficialOpenAiChatReference(): Promise<OfficialOpenAiChatReference | null> {
  if (officialOpenAiChatReference !== undefined) return officialOpenAiChatReference;
  officialOpenAiChatReference = (async () => {
    try {
      // Native ESM import deliberately bypasses caller-poisonable CJS require.cache.
      const module = (await import('@ai-sdk/openai')) as typeof import('@ai-sdk/openai');
      const createOpenAI = module.createOpenAI;
      if (packageMajor(module.VERSION) !== 3 || typeof createOpenAI !== 'function') return null;
      // Only a non-secret sentinel is used while attesting the official class.
      const provider = createOpenAI({ apiKey: 'pylva-official-model-reference' });
      const model = provider.chat('pylva-official-model-reference');
      const prototype = Object.getPrototypeOf(model) as object | null;
      if (prototype === null || nodeUtilTypes.isProxy(prototype)) return null;
      const descriptors = Object.getOwnPropertyDescriptors(prototype) as Record<
        string,
        PropertyDescriptor | undefined
      >;
      const constructor = descriptors['constructor']?.value;
      const providerGetter = descriptors['provider']?.get;
      const getArgs = descriptors['getArgs']?.value;
      const doGenerate = descriptors['doGenerate']?.value;
      const doStream = descriptors['doStream']?.value;
      if (
        typeof constructor !== 'function' ||
        typeof providerGetter !== 'function' ||
        typeof getArgs !== 'function' ||
        typeof doGenerate !== 'function' ||
        typeof doStream !== 'function'
      ) {
        return null;
      }
      return Object.freeze({
        prototype,
        createOpenAI: createOpenAI as (...args: unknown[]) => unknown,
        getArgs: getArgs as (...args: unknown[]) => unknown,
        doGenerate: doGenerate as (...args: unknown[]) => unknown,
        doStream: doStream as (...args: unknown[]) => unknown,
      });
    } catch {
      return null;
    }
  })();
  return officialOpenAiChatReference;
}

function lockPrivateOpenAIChatModel(
  value: unknown,
  model: string,
  reference: OfficialOpenAiChatReference,
): object | null {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)) return null;
  const privateModel = value as Record<string, unknown>;
  try {
    if (Object.getPrototypeOf(privateModel) !== reference.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(privateModel);
    if (
      descriptors['specificationVersion']?.value !== 'v3' ||
      descriptors['modelId']?.value !== model
    ) {
      return null;
    }
    const configObject = descriptors['config']?.value;
    const config = detachedRecord(configObject);
    if (
      config === null ||
      Object.keys(config).length !== OFFICIAL_OPENAI_CONFIG_KEYS.size ||
      Object.keys(config).some((key) => !OFFICIAL_OPENAI_CONFIG_KEYS.has(key)) ||
      config['provider'] !== 'openai.chat' ||
      config['fetch'] !== undefined ||
      typeof config['url'] !== 'function' ||
      typeof config['headers'] !== 'function' ||
      Reflect.apply(config['url'], configObject as object, [
        { path: '/chat/completions', modelId: model },
      ]) !== OPENAI_CHAT_COMPLETIONS_URL
    ) {
      return null;
    }
    const supportedUrls = descriptors['supportedUrls']?.value;
    const supported = detachedRecord(supportedUrls);
    const imageMatchers = supported === null ? null : detachedArray(supported['image/*']);
    if (imageMatchers === null || imageMatchers.length !== 1) return null;
    const imageMatcher = imageMatchers[0];
    if (!(imageMatcher instanceof RegExp) || nodeUtilTypes.isProxy(imageMatcher)) return null;
    Object.freeze(imageMatcher);
    Object.freeze((supportedUrls as Record<string, unknown>)['image/*']);
    Object.freeze(supportedUrls);
    Object.freeze(configObject);
    Object.defineProperties(privateModel, {
      provider: { value: 'openai.chat', enumerable: true },
      getArgs: {
        value: (...args: unknown[]) => Reflect.apply(reference.getArgs, privateModel, args),
      },
      doGenerate: {
        value: (...args: unknown[]) => Reflect.apply(reference.doGenerate, privateModel, args),
      },
      doStream: {
        value: (...args: unknown[]) => Reflect.apply(reference.doStream, privateModel, args),
      },
    });
    return Object.freeze(privateModel);
  } catch {
    return null;
  }
}

/** Build a frozen, opaque, official OpenAI Chat model for strict Vercel AI helpers. */
export async function createControlledOpenAIChatModel(
  input: ControlledOpenAIChatModelOptions,
): Promise<ControlledOpenAIChatModel> {
  const options = detachedRecord(input);
  if (
    options === null ||
    Object.keys(options).length !== 2 ||
    Object.keys(options).some((key) => key !== 'apiKey' && key !== 'model')
  ) {
    return refuseControlledAi('controlled_model_options_are_invalid', false);
  }
  const apiKey = options['apiKey'];
  const model = options['model'];
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > 4_096 ||
    !/^[\x21-\x7e]+$/.test(apiKey)
  ) {
    return refuseControlledAi('provider_api_key_is_invalid', false);
  }
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    model.length > 256 ||
    !/^[\x21-\x7e]+$/.test(model)
  ) {
    return refuseControlledAi('provider_model_is_invalid', false);
  }
  const reference = await loadOfficialOpenAiChatReference();
  if (reference === null) return refuseControlledAi('official_openai_v3_peer_is_required', false);
  let privateModel: unknown;
  try {
    const provider = Reflect.apply(reference.createOpenAI, undefined, [{ apiKey }]) as Record<
      string,
      unknown
    >;
    const chat = provider['chat'];
    if (typeof chat !== 'function') throw new TypeError('official chat factory is unavailable');
    privateModel = Reflect.apply(chat, provider, [model]);
  } catch {
    return refuseControlledAi('official_openai_chat_model_is_unavailable', false);
  }
  const lockedModel = lockPrivateOpenAIChatModel(privateModel, model, reference);
  if (lockedModel === null) {
    return refuseControlledAi('official_openai_chat_model_is_unavailable', false);
  }
  const token = Object.freeze(Object.create(null) as object);
  controlledOpenAIChatModels.set(token, Object.freeze({ provider: 'openai', model, lockedModel }));
  return token as ControlledOpenAIChatModel;
}

function controlledOpenAIChatModelEvidence(value: unknown): ControlledAiModelEvidence {
  if (typeof value !== 'object' || value === null || nodeUtilTypes.isProxy(value)) {
    refuseControlledAi('controlled_openai_chat_model_is_required');
  }
  const evidence = controlledOpenAIChatModels.get(value as object);
  if (evidence === undefined) refuseControlledAi('controlled_openai_chat_model_is_required');
  return evidence;
}

function validateControlledAiRequest(value: unknown): {
  request: ControlledAiRequest;
  provider: 'openai';
  model: string;
  modelEvidence: ControlledAiModelEvidence;
  inputBound: number;
  maxOutputTokens: number;
} {
  const request = detachedRecord(value);
  if (request === null) refuseControlledAi('request_must_be_a_plain_object');
  for (const key of Object.keys(request)) {
    if (!CONTROLLED_AI_KEYS.has(key)) refuseControlledAi('request_contains_unsupported_field');
  }
  const modelEvidence = controlledOpenAIChatModelEvidence(request['model']);
  const { provider, model } = modelEvidence;
  if (!safeUint32(request['maxOutputTokens']) || (request['maxOutputTokens'] as number) < 1) {
    refuseControlledAi('output_token_cap_is_required');
  }
  if (request['maxRetries'] !== undefined && request['maxRetries'] !== 0) {
    refuseControlledAi('provider_retries_must_be_disabled');
  }
  const prompt = request['prompt'];
  const messagesValue = request['messages'];
  const hasPrompt = prompt !== undefined;
  const hasMessages = messagesValue !== undefined;
  if (hasPrompt === hasMessages || (hasPrompt && typeof prompt !== 'string')) {
    refuseControlledAi('exactly_one_text_prompt_shape_is_required');
  }
  if (request['system'] !== undefined && typeof request['system'] !== 'string') {
    refuseControlledAi('system_prompt_must_be_text_only');
  }
  if (hasMessages) {
    const messages = detachedArray(messagesValue);
    if (messages === null || messages.length === 0) {
      refuseControlledAi('messages_must_be_text_only');
    }
    const snapshot: Array<Record<string, unknown>> = [];
    for (const candidate of messages) {
      const message = detachedRecord(candidate);
      if (message === null) refuseControlledAi('messages_must_be_text_only');
      const keys = Object.keys(message);
      if (keys.some((key) => key !== 'role' && key !== 'content')) {
        refuseControlledAi('messages_must_be_text_only');
      }
      if (
        (message['role'] !== 'system' &&
          message['role'] !== 'user' &&
          message['role'] !== 'assistant') ||
        typeof message['content'] !== 'string'
      ) {
        refuseControlledAi('messages_must_be_text_only');
      }
      snapshot.push(message);
    }
    request['messages'] = snapshot;
  }
  const providerOptions = detachedRecord(request['providerOptions']);
  if (providerOptions === null) {
    refuseControlledAi('strict_provider_options_are_required');
  }
  const options = detachedRecord(providerOptions[provider]);
  if (Object.keys(providerOptions).length !== 1 || options === null) {
    refuseControlledAi('strict_provider_options_are_required');
  }
  if (Object.keys(options).some((key) => key !== 'serviceTier')) {
    refuseControlledAi('provider_options_contain_unpriced_feature');
  }
  if (options['serviceTier'] !== 'default') refuseControlledAi('standard_service_tier_is_required');
  request['providerOptions'] = { openai: { serviceTier: 'default' } };
  if (request['stopSequences'] !== undefined) {
    const stopSequences = detachedArray(request['stopSequences']);
    if (
      stopSequences === null ||
      stopSequences.some((entry) => typeof entry !== 'string' || entry.length > 1_000_000)
    ) {
      refuseControlledAi('stop_sequences_must_be_text_only');
    }
    request['stopSequences'] = stopSequences;
  }
  if (request['timeout'] !== undefined && typeof request['timeout'] !== 'number') {
    const timeout = detachedRecord(request['timeout']);
    if (
      timeout === null ||
      Object.keys(timeout).some(
        (key) =>
          !['totalMs', 'stepMs', 'chunkMs'].includes(key) ||
          typeof timeout[key] !== 'number' ||
          !Number.isFinite(timeout[key]) ||
          (timeout[key] as number) < 0,
      )
    ) {
      refuseControlledAi('timeout_configuration_is_invalid');
    }
    request['timeout'] = timeout;
  }
  if (
    typeof request['timeout'] === 'number' &&
    (!Number.isFinite(request['timeout']) || request['timeout'] < 0)
  ) {
    refuseControlledAi('timeout_configuration_is_invalid');
  }
  for (const key of [
    'temperature',
    'topP',
    'topK',
    'presencePenalty',
    'frequencyPenalty',
    'seed',
  ]) {
    const candidate = request[key];
    if (candidate !== undefined && (typeof candidate !== 'number' || !Number.isFinite(candidate))) {
      refuseControlledAi('numeric_option_must_be_finite');
    }
  }
  for (const key of ['onFinish', 'onError', 'onAbort', 'onChunk']) {
    if (request[key] !== undefined && typeof request[key] !== 'function') {
      refuseControlledAi('callback_must_be_a_function');
    }
  }
  if (request['abortSignal'] !== undefined && !isControlledAbortSignal(request['abortSignal'])) {
    refuseControlledAi('abort_signal_is_invalid');
  }
  const boundShape = {
    system: request['system'] ?? null,
    prompt: request['prompt'] ?? null,
    messages: request['messages'] ?? null,
  } as Parameters<typeof _controlledAiInputBoundForTests>[0];
  const inputBound = _controlledAiInputBoundForTests(boundShape);
  if (inputBound >= 1_024) {
    refuseControlledAi('sub_1024_prompt_bound_is_required');
  }
  return {
    request: request as ControlledAiRequest,
    provider,
    model,
    modelEvidence,
    inputBound,
    maxOutputTokens: request['maxOutputTokens'] as number,
  };
}

const UNIFIED_USAGE_KEYS = new Set([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reasoningTokens',
  'cachedInputTokens',
  'inputTokenDetails',
  'outputTokenDetails',
  'raw',
]);
const RAW_USAGE_KEYS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'prompt_tokens_details',
  'input_tokens_details',
  'completion_tokens_details',
  'output_tokens_details',
  'service_tier',
]);
const METADATA_KEYS = new Set([
  'serviceTier',
  'service_tier',
  'responseId',
  'requestId',
  'systemFingerprint',
  'logprobs',
  'acceptedPredictionTokens',
  'rejectedPredictionTokens',
  'reasoningTokens',
]);

function controlledAiUsage(
  value: unknown,
  metadataValue: unknown,
): { inputTokens: number; outputTokens: number } | null {
  if (!isPlainRecord(value) || !knownOrZero(value, UNIFIED_USAGE_KEYS)) return null;
  const input = value.inputTokens;
  const output = value.outputTokens;
  if (
    !safeUint32(input) ||
    !safeUint32(output) ||
    !tokenMatches(value.totalTokens, input + output) ||
    !tokenMatches(value.reasoningTokens, output, true) ||
    !zeroPaidEvidence(value.cachedInputTokens) ||
    !usageDetailsAreSupported(value.inputTokenDetails, /^noCacheTokens$/, input) ||
    !usageDetailsAreSupported(value.outputTokenDetails, /^(text|reasoning)Tokens$/, output) ||
    (isPlainRecord(value.inputTokenDetails) &&
      !tokenMatches(value.inputTokenDetails.noCacheTokens, input)) ||
    (value.raw !== undefined && !paidRawUsageIsSupported(value.raw, input, output))
  ) {
    return null;
  }
  if (metadataValue !== undefined) {
    if (!isPlainRecord(metadataValue) || !knownOrZero(metadataValue, new Set(['openai']))) {
      return null;
    }
    const metadata = metadataValue.openai;
    if (metadata !== undefined) {
      if (!isPlainRecord(metadata) || !knownOrZero(metadata, METADATA_KEYS)) return null;
      if (
        !['serviceTier', 'service_tier'].every((key) => {
          const tier = metadata[key];
          return tier === undefined || tier === null || tier === 'default';
        }) ||
        !['acceptedPredictionTokens', 'rejectedPredictionTokens', 'reasoningTokens'].every((key) =>
          tokenMatches(metadata[key], output, true),
        )
      ) {
        return null;
      }
    }
  }
  return { inputTokens: input, outputTokens: output };
}

function tokenMatches(value: unknown, expected: number, atMost = false): boolean {
  if (value === undefined || value === null) return true;
  return safeUint32(value) && (atMost ? value <= expected : value === expected);
}

function zeroPaidEvidence(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (value === undefined || value === null || value === 0 || value === false || value === '') {
    return true;
  }
  if (typeof value !== 'object') return false;
  if (
    depth > 8 ||
    seen.has(value) ||
    (Array.isArray(value) && value.length > 256) ||
    (!Array.isArray(value) && !isPlainRecord(value))
  ) {
    return false;
  }
  const entries = Object.values(value);
  if (entries.length > 256) return false;
  seen.add(value);
  return entries.every((entry) => zeroPaidEvidence(entry, depth + 1, seen));
}

function knownOrZero(value: Record<string, unknown>, known: ReadonlySet<string>): boolean {
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(([key, entry]) => known.has(key) || zeroPaidEvidence(entry))
  );
}

function usageDetailsAreSupported(
  value: unknown,
  baseTokenKey?: RegExp,
  maxTokens?: number,
): boolean {
  if (value === undefined || value === null) return true;
  if (!isPlainRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 256) return false;
  for (const [key, entry] of entries) {
    if (
      baseTokenKey?.test(key)
        ? maxTokens === undefined || !tokenMatches(entry, maxTokens, true)
        : !zeroPaidEvidence(entry)
    )
      return false;
  }
  return true;
}

function paidRawUsageIsSupported(value: unknown, input: number, output: number): boolean {
  if (!isPlainRecord(value) || !knownOrZero(value, RAW_USAGE_KEYS)) return false;
  if (
    !['prompt_tokens', 'input_tokens'].every((key) => tokenMatches(value[key], input)) ||
    !['completion_tokens', 'output_tokens'].every((key) => tokenMatches(value[key], output)) ||
    !tokenMatches(value.total_tokens, input + output) ||
    !usageDetailsAreSupported(value.prompt_tokens_details) ||
    !usageDetailsAreSupported(value.input_tokens_details) ||
    !usageDetailsAreSupported(
      value.completion_tokens_details,
      /^(accepted_prediction|reasoning|rejected_prediction|text)_tokens$/,
      output,
    ) ||
    !usageDetailsAreSupported(
      value.output_tokens_details,
      /^(accepted_prediction|reasoning|rejected_prediction|text)_tokens$/,
      output,
    )
  ) {
    return false;
  }
  const tier = value.service_tier;
  return tier === undefined || tier === null || tier === 'default';
}

async function settleControlledAiResult(
  attempt: ControlledAttemptHandle,
  result: unknown,
  terminalEvent: boolean,
  model: string,
  startedAt: number,
): Promise<void> {
  try {
    const record: Record<string, unknown> = isObject(result) ? result : {};
    const responseValue = record.response;
    const responseRecord: Record<string, unknown> = isObject(responseValue) ? responseValue : {};
    if ((record.modelId ?? responseRecord.modelId) !== model) return;
    const usage = controlledAiUsage(
      terminalEvent ? (record.totalUsage ?? record.usage) : record.usage,
      record.providerMetadata,
    );
    if (usage === null) return;
    if (attempt.ownsReservation) {
      await attempt.settleExact({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
    } else if (attempt.legacyTelemetryRequired && attempt.identityIsCurrent()) {
      emitSuccess(model, usage, 'openai', startedAt, 'controlledVercel', getConfigGeneration());
    }
  } catch {
    // Post-dispatch evidence and settlement never replace provider success.
  }
}

async function originalAiFunction(
  name: 'generateText' | 'streamText',
): Promise<(input: unknown) => unknown> {
  let module: Record<string, unknown>;
  let installedMajor: number | null;
  try {
    // The executable peer is a native ESM import so a caller cannot replace it
    // through CommonJS require.cache. Read the installed manifest itself for
    // the same reason: Node's JSON import currently observes a poisoned CJS
    // cache entry for that manifest.
    module = (await import('ai')) as Record<string, unknown>;
    installedMajor = installedAiMajor();
  } catch {
    refuseControlledAi('ai_sdk_function_is_unavailable');
  }
  if (installedMajor !== 6) {
    refuseControlledAi('ai_sdk_v6_is_required');
  }
  const candidate = module?.[name];
  if (typeof candidate !== 'function') refuseControlledAi('ai_sdk_function_is_unavailable');
  const original = originalProviderMethod(candidate);
  if (original === null) refuseControlledAi('unknown_legacy_patch_cannot_be_bypassed');
  return original as (input: unknown) => unknown;
}

function reattestControlledAiRequest(
  request: Record<string, unknown>,
  expected: ControlledAiModelEvidence,
): void {
  const signal = request['abortSignal'] as AbortSignal | undefined;
  if (signal !== undefined && abortSignalValue(abortSignalAbortedGetter, signal) === true)
    refuseControlledAi('request_aborted_before_provider_dispatch', false);
  if (request['model'] !== expected.lockedModel) {
    refuseControlledAi('model_changed_before_provider_dispatch', false);
  }
}

/** Strict one-step, direct-provider Vercel AI generateText helper. */
export async function controlledGenerateText<T = unknown>(input: unknown): Promise<T> {
  const normalized = validateControlledAiRequest(input);
  const original = await originalAiFunction('generateText');
  const callerSignal = normalized.request['abortSignal'] as AbortSignal | undefined;
  if (callerSignal !== undefined && !isControlledAbortSignal(callerSignal)) {
    refuseControlledAi('abort_signal_is_invalid');
  }
  const providerAbort = new AbortController();
  const unlinkCaller =
    callerSignal === undefined
      ? () => {}
      : observeAbortSignal(callerSignal, (reason) => providerAbort.abort(reason));
  const startedAt = Date.now();
  const request: Record<string, unknown> = {
    ...normalized.request,
    model: normalized.modelEvidence.lockedModel,
    ...(callerSignal === undefined ? {} : { abortSignal: providerAbort.signal }),
    maxRetries: 0,
  };
  let legacyTerminalEmitted = false;
  const emitLegacyFailure = (attempt: ControlledAttemptHandle): void => {
    if (legacyTerminalEmitted || !attempt.legacyTelemetryRequired || !attempt.identityIsCurrent()) {
      return;
    }
    legacyTerminalEmitted = true;
    emitTerminal(
      EventStatus.FAILURE,
      normalized.model,
      normalized.provider,
      startedAt,
      'controlledGenerateText',
      getConfigGeneration(),
    );
  };
  try {
    const launched = await executeControlledAttempt<Promise<T>>({
      provider: normalized.provider,
      model: normalized.model,
      estimatedInputTokens: normalized.inputBound,
      maxOutputTokens: normalized.maxOutputTokens,
      predispatchCheck: () => reattestControlledAiRequest(request, normalized.modelEvidence),
      dispatchThrew: (_error, attempt) => emitLegacyFailure(attempt),
      dispatch: () => original(request) as Promise<T>,
    });
    let result: T;
    try {
      result = await launched.value;
    } catch (error) {
      emitLegacyFailure(launched.attempt);
      throw error;
    }
    await settleControlledAiResult(launched.attempt, result, false, normalized.model, startedAt);
    return result;
  } finally {
    unlinkCaller();
  }
}

function observeReadableCancellation(
  stream: ReadableStream<unknown>,
  onStart: () => void,
  onDone: () => void,
  onCancel: (reason?: unknown) => void,
) {
  const reader = stream.getReader();
  let finished = false;
  return new ReadableStream<unknown>(
    {
      async pull(controller) {
        onStart();
        try {
          const item = await reader.read();
          if (finished) return;
          if (item.done) {
            finished = true;
            onDone();
            controller.close();
          } else {
            controller.enqueue(item.value);
          }
        } catch (error) {
          if (finished) return;
          finished = true;
          onCancel(error);
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (finished) return;
        finished = true;
        onCancel(reason);
        try {
          await reader.cancel(reason);
        } catch {
          // The internal provider abort can race this branch cancellation.
        }
      },
    },
    { highWaterMark: 0 },
  );
}

function observeConsumerCancellation<T>(
  value: T,
  onStart: () => void,
  onDone: () => void,
  onCancel: (reason?: unknown) => void,
): T {
  if (!isObject(value)) return value;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return value;
  try {
    for (const key of ['textStream', 'fullStream', 'partialOutputStream'] as const) {
      const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
      if (getter === undefined) continue;
      Object.defineProperty(value, key, {
        configurable: true,
        get: () => observeReadableCancellation(getter.call(value), onStart, onDone, onCancel),
      });
    }
    const toUIMessageStream = value['toUIMessageStream'];
    if (typeof toUIMessageStream === 'function') {
      Object.defineProperty(value, 'toUIMessageStream', {
        configurable: true,
        value: (...args: unknown[]) =>
          observeReadableCancellation(
            Reflect.apply(toUIMessageStream, value, args) as ReadableStream<unknown>,
            onStart,
            onDone,
            onCancel,
          ),
      });
    }
  } catch {
    // Never replace a dispatched provider stream with instrumentation failure.
  }
  return value;
}

/** Async strict counterpart to Vercel AI's intentionally synchronous streamText. */
export async function controlledStreamText<T = unknown>(input: unknown): Promise<T> {
  const normalized = validateControlledAiRequest(input);
  const original = await originalAiFunction('streamText');
  const callerSignal = normalized.request['abortSignal'] as AbortSignal | undefined;
  if (callerSignal !== undefined && !isControlledAbortSignal(callerSignal)) {
    refuseControlledAi('abort_signal_is_invalid');
  }
  const startedAt = Date.now();
  const providerAbort = new AbortController();
  let unlinkCaller = (): void => {};
  let attempt: ControlledAttemptHandle | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let terminalObserved = false;
  let pendingLegacyTerminal: (typeof EventStatus)[keyof typeof EventStatus] | null = null;
  const emitLegacyNow = (status: (typeof EventStatus)[keyof typeof EventStatus]): void => {
    if (!attempt || !attempt.legacyTelemetryRequired || !attempt.identityIsCurrent()) return;
    emitTerminal(
      status,
      normalized.model,
      normalized.provider,
      startedAt,
      'controlledStreamText',
      getConfigGeneration(),
    );
  };
  const emitLegacyTerminal = (status: (typeof EventStatus)[keyof typeof EventStatus]): void => {
    if (terminalObserved) return;
    terminalObserved = true;
    if (attempt === null) pendingLegacyTerminal = status;
    else emitLegacyNow(status);
  };
  const startHeartbeat = (): void => {
    if (!terminalObserved && attempt && !stopHeartbeat) {
      stopHeartbeat = attempt.startHeartbeat();
    }
  };
  const finishConsumption = (): void => {
    stopHeartbeat?.();
    unlinkCaller();
  };
  const abortStream = (reason?: unknown): void => {
    if (terminalObserved) return;
    finishConsumption();
    emitLegacyTerminal(EventStatus.ABORTED);
    providerAbort.abort(
      reason ?? new DOMException('stream consumer stopped before EOF', 'AbortError'),
    );
  };
  if (callerSignal) unlinkCaller = observeAbortSignal(callerSignal, abortStream);
  const userOnChunk = normalized.request['onChunk'];
  const callUser = (name: 'onFinish' | 'onAbort' | 'onError', event: unknown): unknown => {
    const callback = normalized.request[name];
    return typeof callback === 'function' ? callback(event) : undefined;
  };
  const request: Record<string, unknown> = {
    ...normalized.request,
    model: normalized.modelEvidence.lockedModel,
    abortSignal: providerAbort.signal,
    maxRetries: 0,
    onChunk(event: unknown) {
      if (terminalObserved) return undefined;
      startHeartbeat();
      if (typeof userOnChunk === 'function') {
        try {
          return Promise.resolve(userOnChunk(event)).catch((error: unknown) => {
            abortStream(error);
            throw error;
          });
        } catch (error) {
          abortStream(error);
          throw error;
        }
      }
      return undefined;
    },
    onFinish(event: unknown) {
      finishConsumption();
      const firstTerminal = !terminalObserved;
      terminalObserved = true;
      if (firstTerminal && attempt) {
        void settleControlledAiResult(attempt, event, true, normalized.model, startedAt);
      }
      return callUser('onFinish', event);
    },
    onAbort(event: unknown) {
      finishConsumption();
      emitLegacyTerminal(EventStatus.ABORTED);
      return callUser('onAbort', event);
    },
    onError(event: unknown) {
      finishConsumption();
      emitLegacyTerminal(EventStatus.FAILURE);
      return callUser('onError', event);
    },
  };
  const launched = await executeControlledAttempt<T>({
    provider: normalized.provider,
    model: normalized.model,
    estimatedInputTokens: normalized.inputBound,
    maxOutputTokens: normalized.maxOutputTokens,
    predispatchCheck: () => reattestControlledAiRequest(request, normalized.modelEvidence),
    dispatchThrew: (_error, ownedAttempt) => {
      attempt = ownedAttempt;
      finishConsumption();
      emitLegacyTerminal(EventStatus.FAILURE);
    },
    dispatch: () => original(request) as T,
  }).catch((error: unknown) => {
    finishConsumption();
    throw error;
  });
  attempt = launched.attempt;
  if (pendingLegacyTerminal) {
    emitLegacyNow(pendingLegacyTerminal);
    pendingLegacyTerminal = null;
  }
  return observeConsumerCancellation(
    launched.value,
    startHeartbeat,
    finishConsumption,
    abortStream,
  );
}

export { PylvaStrictProviderError } from '../errors/strict_provider.js';
