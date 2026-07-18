import { EventStatus, Provider, TokenCountSource } from '@pylva/shared/telemetry-values';
import { createRequire } from 'node:module';
import {
  executeControlledAttempt,
  type ControlledAttemptHandle,
  type ControlledAttemptOptions,
} from '../core/control_attempt.js';
import { linkLocalControlledCallbackNoDispatch } from '../core/control_correlation.js';
import { enqueue } from '../core/telemetry.js';
import { PylvaStrictProviderError } from '../errors/strict_provider.js';
import { buildLlmEvent } from './_event.js';
import {
  createControlledStreamLifecycle,
  wrapControlledAsyncStream,
  type ControlledStreamLifecycle,
} from './_controlled_stream.js';
import { DeferredControlledPromise, type ProviderPromiseLike } from './_controlled_promise.js';
import {
  abortSignalIsAborted,
  assertJsonSerializationPosture,
  detachValidatedJson,
  isPlainRecord,
  isProxyObject,
  snapshotOwnDataProperties,
} from './_usage_bound.js';
import { originalProviderMethod } from './_strict_unwrap.js';

const PROVIDER = 'openai' as const;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const TOP_LEVEL_KEYS = new Set([
  'model',
  'messages',
  'max_completion_tokens',
  'max_tokens',
  'n',
  'service_tier',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'parallel_tool_calls',
  'response_format',
  'metadata',
  'safety_identifier',
]);
const MESSAGE_KEYS = new Set([
  'role',
  'content',
  'name',
  'tool_call_id',
  'tool_calls',
  'function_call',
]);
const REQUEST_OPTION_KEYS = new Set(['signal', 'timeout', 'maxRetries']);

type OfficialConstructor = (new (options: Record<string, unknown>) => object) & Function;

function supportedOpenAIVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 5 || (major === 4 && minor >= 104);
}

export interface StrictOpenAIOptions extends ControlledAttemptOptions {}

type OpenAICreateMethod<T> = T extends {
  chat: { completions: { create: infer TCreate } };
}
  ? TCreate
  : never;

type OpenAICloseMethod<T> = T extends { close: infer TClose } ? TClose : () => unknown;

export interface ControlledOpenAIClient<TClient extends object> {
  readonly maxRetries: 0;
  readonly chat: {
    readonly completions: {
      readonly create: OpenAICreateMethod<TClient>;
    };
  };
  readonly close: OpenAICloseMethod<TClient>;
}

interface OpenAIResource {
  _client?: unknown;
  create(body: unknown, options?: unknown): ProviderPromiseLike<unknown>;
}

interface OpenAIClientShape {
  apiKey?: unknown;
  baseURL: string;
  fetch?: unknown;
  maxRetries: number;
  organization?: unknown;
  project?: unknown;
  timeout?: unknown;
  fetchOptions?: unknown;
  _options?: {
    defaultHeaders?: unknown;
    defaultQuery?: unknown;
    fetch?: unknown;
    fetchOptions?: unknown;
  };
  chat: { completions: OpenAIResource };
}

interface ExactUsage {
  inputTokens: number;
  outputTokens: number;
}

interface PropertyIdentity {
  owner: object | null;
  value: unknown;
}

interface CapturedClientPosture {
  create: PropertyIdentity;
  fetch: PropertyIdentity;
  resourceClient: PropertyIdentity;
}

interface IsolatedOpenAIDispatch {
  client: Partial<OpenAIClientShape> | null;
  resource: OpenAIResource;
  invoke(body: unknown, options?: unknown): ProviderPromiseLike<unknown>;
}

type FacadeLifecycle = ControlledStreamLifecycle;

function refuse(reason: string, local = true): never {
  if (local) linkLocalControlledCallbackNoDispatch('llm');
  throw new PylvaStrictProviderError(PROVIDER, reason);
}

function refuseEvidence(reason: string): never {
  throw new PylvaStrictProviderError(PROVIDER, reason);
}

function propertyIdentity(value: object, key: PropertyKey, local = true): PropertyIdentity {
  try {
    let owner: object | null = value;
    for (let depth = 0; depth < 16 && owner !== null; depth += 1) {
      if (isProxyObject(owner)) refuse('invalid_client', local);
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) {
        if (!('value' in descriptor)) refuse('invalid_client', local);
        return { owner, value: descriptor.value };
      }
      owner = Object.getPrototypeOf(owner) as object | null;
    }
    if (owner !== null) refuse('invalid_client', local);
    return { owner: null, value: undefined };
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) throw error;
    refuse('invalid_client', local);
  }
}

function captureClientPosture(
  candidate: Partial<OpenAIClientShape>,
  resource: OpenAIResource,
  allowOfficialBundledFetch = false,
): CapturedClientPosture {
  const create = propertyIdentity(resource, 'create');
  const fetch = propertyIdentity(candidate, 'fetch');
  const resourceClient = propertyIdentity(resource, '_client');
  if (typeof create.value !== 'function') refuse('chat_completions_are_unavailable');
  if (!allowOfficialBundledFetch && fetch.owner !== null && fetch.value !== globalThis.fetch) {
    refuse('custom_client_transport_headers_or_query_are_unsupported');
  }
  if (resourceClient.owner !== null && resourceClient.value !== candidate) {
    refuse('invalid_client');
  }
  return { create, fetch, resourceClient };
}

function samePropertyIdentity(left: PropertyIdentity, right: PropertyIdentity): boolean {
  return left.owner === right.owner && left.value === right.value;
}

function hasLocalLegacyPatchMarker(candidate: Function): boolean {
  const marker = Object.getOwnPropertyDescriptor(candidate, '__pylva_patched');
  return marker !== undefined && 'value' in marker && marker.value === true;
}

function assertMatchesTrustedDefaultFetch(
  candidate: Partial<OpenAIClientShape>,
  trustedCallerConstructor: OfficialConstructor,
): void {
  let probe: Partial<OpenAIClientShape>;
  try {
    probe = Reflect.construct(trustedCallerConstructor, [
      {
        apiKey: 'pylva-posture-probe',
        baseURL: OPENAI_BASE_URL,
        maxRetries: 0,
      },
    ]) as Partial<OpenAIClientShape>;
  } catch {
    refuse('invalid_client');
  }
  const candidateFetch = propertyIdentity(candidate, 'fetch');
  const trustedFetch = propertyIdentity(probe, 'fetch');
  if (candidateFetch.value !== trustedFetch.value) {
    refuse('custom_client_transport_headers_or_query_are_unsupported');
  }
}

function validatedCommonJsConstructor(
  candidatePrototype: object | null,
): OfficialConstructor | null {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve('openai');
    const peer = require('openai') as { default?: unknown; OpenAI?: unknown };
    const cacheEntry = require.cache[resolved];
    if (
      cacheEntry === undefined ||
      cacheEntry.id !== resolved ||
      cacheEntry.filename !== resolved ||
      cacheEntry.loaded !== true ||
      cacheEntry.exports !== peer ||
      !Array.isArray(cacheEntry.paths)
    ) {
      return null;
    }
    for (const constructor of [peer.OpenAI, peer.default]) {
      if (
        typeof constructor === 'function' &&
        candidatePrototype !== null &&
        candidatePrototype === constructor.prototype
      ) {
        return constructor as OfficialConstructor;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function ownClientValue(candidate: Partial<OpenAIClientShape>, key: PropertyKey): unknown {
  const identity = propertyIdentity(candidate, key);
  if (identity.owner !== null && identity.owner !== candidate) refuse('invalid_client');
  return identity.value;
}

function cloneFallbackDispatchResource(
  candidate: Partial<OpenAIClientShape>,
  resource: OpenAIResource,
): OpenAIResource {
  try {
    const clientClone = Object.create(Object.getPrototypeOf(candidate)) as Record<
      PropertyKey,
      unknown
    >;
    Object.defineProperties(clientClone, Object.getOwnPropertyDescriptors(candidate));
    const descriptors = Object.getOwnPropertyDescriptors(resource);
    if (descriptors['_client'] !== undefined) {
      descriptors['_client'] = { ...descriptors['_client'], value: clientClone };
    }
    const resourceClone = Object.create(Object.getPrototypeOf(resource)) as OpenAIResource;
    Object.defineProperties(resourceClone, descriptors);
    return resourceClone;
  } catch {
    refuse('invalid_client');
  }
}

function isolateDispatch(
  candidate: Partial<OpenAIClientShape>,
  resource: OpenAIResource,
  officialConstructor: OfficialConstructor | null,
  trustedCallerConstructor: OfficialConstructor | null,
): IsolatedOpenAIDispatch {
  let isolatedClient: Partial<OpenAIClientShape> | null = null;
  let isolatedResource: OpenAIResource;
  if (officialConstructor !== null) {
    if (trustedCallerConstructor === null) refuse('invalid_client');
    assertMatchesTrustedDefaultFetch(candidate, trustedCallerConstructor);
    const apiKey = ownClientValue(candidate, 'apiKey');
    const organization = ownClientValue(candidate, 'organization');
    const project = ownClientValue(candidate, 'project');
    const timeout = ownClientValue(candidate, 'timeout');
    if (
      typeof apiKey !== 'string' ||
      apiKey.length === 0 ||
      (organization !== undefined && organization !== null && typeof organization !== 'string') ||
      (project !== undefined && project !== null && typeof project !== 'string') ||
      (timeout !== undefined && (!Number.isFinite(timeout) || (timeout as number) <= 0))
    ) {
      refuse('invalid_client');
    }
    try {
      isolatedClient = Reflect.construct(officialConstructor, [
        {
          apiKey,
          baseURL: OPENAI_BASE_URL,
          maxRetries: 0,
          ...(organization !== undefined ? { organization } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
        },
      ]) as Partial<OpenAIClientShape>;
      isolatedResource = isolatedClient.chat?.completions as OpenAIResource;
    } catch (error) {
      if (error instanceof PylvaStrictProviderError) throw error;
      refuse('invalid_client');
    }
  } else {
    isolatedResource = cloneFallbackDispatchResource(candidate, resource);
  }
  let invoke: OpenAIResource['create'] | null = null;
  try {
    if (!isolatedResource) refuse('invalid_client');
    if (isolatedClient !== null) {
      const post = propertyIdentity(isolatedClient, 'post').value;
      if (typeof post !== 'function') refuse('invalid_client');
      invoke = (body: unknown, options?: unknown) =>
        post.call(isolatedClient, '/chat/completions', {
          body,
          ...(isPlainRecord(options) ? options : {}),
          stream: isPlainRecord(body) && body['stream'] === true,
        }) as ProviderPromiseLike<unknown>;
    } else {
      const create = propertyIdentity(isolatedResource, 'create').value;
      if (typeof create !== 'function') refuse('invalid_client');
      const original = originalProviderMethod(create as OpenAIResource['create']);
      if (original === null) refuse('unknown_legacy_patch_cannot_be_bypassed');
      invoke = (body: unknown, options?: unknown) => original.call(isolatedResource, body, options);
    }
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) throw error;
    refuse('invalid_client');
  }
  if (invoke === null) refuse('invalid_client');
  return { client: isolatedClient, resource: isolatedResource, invoke };
}

function assertOfficialIdentity(
  candidate: Partial<OpenAIClientShape>,
  resource: OpenAIResource,
  create: OpenAIResource['create'],
  trustedConstructor: Function,
): void {
  try {
    const candidatePrototype = Object.getPrototypeOf(candidate) as object | null;
    const constructor = candidatePrototype
      ? Object.getOwnPropertyDescriptor(candidatePrototype, 'constructor')?.value
      : undefined;
    if (
      typeof constructor !== 'function' ||
      constructor !== trustedConstructor ||
      candidatePrototype !== trustedConstructor.prototype ||
      Object.prototype.hasOwnProperty.call(candidate, 'constructor') ||
      Object.prototype.hasOwnProperty.call(candidate, 'getUserAgent')
    ) {
      refuse('invalid_client');
    }
    const chatConstructor = Object.getOwnPropertyDescriptor(constructor, 'Chat')?.value;
    const resourceConstructor =
      typeof chatConstructor === 'function'
        ? Object.getOwnPropertyDescriptor(chatConstructor, 'Completions')?.value
        : undefined;
    if (
      typeof resourceConstructor !== 'function' ||
      Object.getPrototypeOf(resource) !== resourceConstructor.prototype ||
      Object.prototype.hasOwnProperty.call(resource, 'create')
    ) {
      refuse('invalid_client');
    }
    const resourceCreate = propertyIdentity(resourceConstructor.prototype, 'create');
    if (resourceCreate.owner !== resourceConstructor.prototype || resourceCreate.value !== create) {
      refuse('invalid_client');
    }
    if (create.name !== 'create' && !hasLocalLegacyPatchMarker(create)) {
      refuse('invalid_client');
    }
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) throw error;
    refuse('invalid_client');
  }
}

function strictFacade(entries: ReadonlyMap<string | symbol, unknown>): object {
  const target = Object.create(null) as object;
  return new Proxy(target, {
    get(_target, property) {
      if (entries.has(property)) return entries.get(property);
      if (property === 'then') return undefined;
      refuse('unsupported_pricing_feature');
    },
    getOwnPropertyDescriptor(_target, property) {
      if (!entries.has(property)) refuse('unsupported_pricing_feature');
      return {
        value: entries.get(property),
        enumerable: true,
        configurable: true,
        writable: false,
      };
    },
    ownKeys() {
      return [...entries.keys()];
    },
    has(_target, property) {
      return entries.has(property);
    },
    getPrototypeOf() {
      return null;
    },
    set() {
      refuse('unsupported_pricing_feature');
    },
    defineProperty() {
      refuse('unsupported_pricing_feature');
    },
    deleteProperty() {
      refuse('unsupported_pricing_feature');
    },
    setPrototypeOf() {
      refuse('unsupported_pricing_feature');
    },
  });
}

function assertClientPosture(
  candidate: Partial<OpenAIClientShape>,
  resource: OpenAIResource,
  expected: CapturedClientPosture,
  local = true,
): void {
  let reason: string | null = null;
  try {
    if (isProxyObject(candidate) || isProxyObject(resource)) {
      reason = 'invalid_client';
    } else {
      const baseURL = propertyIdentity(candidate, 'baseURL', local).value;
      const maxRetries = propertyIdentity(candidate, 'maxRetries', local).value;
      const clientOptions = propertyIdentity(candidate, '_options', local).value;
      const fetchOptions = propertyIdentity(candidate, 'fetchOptions', local).value;
      if (typeof baseURL !== 'string' || baseURL.replace(/\/+$/, '') !== OPENAI_BASE_URL) {
        reason = 'official_provider_endpoint_is_required';
      } else if (maxRetries !== 0) {
        reason = 'provider_retries_must_be_disabled';
      } else if (
        isProxyObject(clientOptions) ||
        (clientOptions !== undefined &&
          (typeof clientOptions !== 'object' || clientOptions === null)) ||
        (clientOptions !== undefined &&
          (propertyIdentity(clientOptions, 'defaultHeaders', local).value !== undefined ||
            propertyIdentity(clientOptions, 'defaultQuery', local).value !== undefined ||
            propertyIdentity(clientOptions, 'fetch', local).value !== undefined ||
            propertyIdentity(clientOptions, 'fetchOptions', local).value !== undefined ||
            propertyIdentity(clientOptions, 'httpAgent', local).value !== undefined ||
            propertyIdentity(clientOptions, 'agent', local).value !== undefined ||
            propertyIdentity(clientOptions, 'dispatcher', local).value !== undefined)) ||
        fetchOptions !== undefined
      ) {
        reason = 'custom_client_transport_headers_or_query_are_unsupported';
      } else {
        const chat = propertyIdentity(candidate, 'chat', local).value;
        const current = propertyIdentity(resource, 'create', local).value;
        const fetch = propertyIdentity(candidate, 'fetch', local);
        const resourceClient = propertyIdentity(resource, '_client', local);
        if (
          typeof chat !== 'object' ||
          chat === null ||
          isProxyObject(chat) ||
          propertyIdentity(chat, 'completions', local).value !== resource ||
          !samePropertyIdentity(fetch, expected.fetch) ||
          !samePropertyIdentity(resourceClient, expected.resourceClient) ||
          !samePropertyIdentity(propertyIdentity(resource, 'create', local), expected.create) ||
          (resourceClient.owner !== null && resourceClient.value !== candidate) ||
          typeof current !== 'function'
        ) {
          reason = 'invalid_client';
        }
      }
    }
  } catch {
    reason = 'invalid_client';
  }
  if (reason !== null) refuse(reason, local);
}

function assertExactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) refuse('request_contains_unsupported_field');
  }
}

function positiveUint32(value: unknown, reason: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 4_294_967_295) {
    refuse(reason);
  }
  return value as number;
}

function validateTextContent(value: unknown, allowNull: boolean): void {
  if (typeof value === 'string' || (allowNull && value === null)) return;
  if (!Array.isArray(value) || value.length === 0) refuse('messages_must_be_text_only');
  for (const part of value) {
    if (!isPlainRecord(part)) refuse('messages_must_be_text_only');
    assertExactKeys(part, new Set(['type', 'text']));
    if (part['type'] !== 'text' || typeof part['text'] !== 'string') {
      refuse('messages_must_be_text_only');
    }
  }
}

function validateFunctionCall(value: unknown): void {
  if (!isPlainRecord(value)) refuse('client_function_call_is_invalid');
  assertExactKeys(value, new Set(['name', 'arguments']));
  if (typeof value['name'] !== 'string' || typeof value['arguments'] !== 'string') {
    refuse('client_function_call_is_invalid');
  }
}

function validateMessages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) refuse('messages_are_required');
  for (const rawMessage of value) {
    if (!isPlainRecord(rawMessage)) refuse('message_is_invalid');
    assertExactKeys(rawMessage, MESSAGE_KEYS);
    const role = rawMessage['role'];
    if (
      role !== 'system' &&
      role !== 'developer' &&
      role !== 'user' &&
      role !== 'assistant' &&
      role !== 'tool' &&
      role !== 'function'
    ) {
      refuse('message_role_is_unsupported');
    }
    validateTextContent(rawMessage['content'], role === 'assistant');
    if (rawMessage['tool_calls'] !== undefined) {
      if (role !== 'assistant' || !Array.isArray(rawMessage['tool_calls'])) {
        refuse('client_function_call_is_invalid');
      }
      for (const toolCall of rawMessage['tool_calls']) {
        if (!isPlainRecord(toolCall)) refuse('client_function_call_is_invalid');
        assertExactKeys(toolCall, new Set(['id', 'type', 'function']));
        if (typeof toolCall['id'] !== 'string' || toolCall['type'] !== 'function') {
          refuse('client_function_call_is_invalid');
        }
        validateFunctionCall(toolCall['function']);
      }
    }
    if (rawMessage['function_call'] !== undefined) {
      if (role !== 'assistant') refuse('client_function_call_is_invalid');
      validateFunctionCall(rawMessage['function_call']);
    }
    if (role === 'tool' && typeof rawMessage['tool_call_id'] !== 'string') {
      refuse('client_function_call_is_invalid');
    }
  }
}

function validateClientTools(body: Record<string, unknown>): void {
  if (body['tools'] !== undefined) {
    if (!Array.isArray(body['tools'])) refuse('client_tools_are_invalid');
    for (const tool of body['tools']) {
      if (!isPlainRecord(tool)) refuse('client_tools_are_invalid');
      assertExactKeys(tool, new Set(['type', 'function']));
      if (tool['type'] !== 'function' || !isPlainRecord(tool['function'])) {
        refuse('remote_or_hosted_tools_are_unsupported');
      }
      const fn = tool['function'];
      assertExactKeys(fn, new Set(['name', 'description', 'parameters', 'strict']));
      if (typeof fn['name'] !== 'string') refuse('client_tools_are_invalid');
      if (fn['description'] !== undefined && typeof fn['description'] !== 'string') {
        refuse('client_tools_are_invalid');
      }
      if (fn['parameters'] !== undefined && !isPlainRecord(fn['parameters'])) {
        refuse('client_tools_are_invalid');
      }
      if (fn['strict'] !== undefined && typeof fn['strict'] !== 'boolean') {
        refuse('client_tools_are_invalid');
      }
    }
  }
  if (body['functions'] !== undefined) {
    if (!Array.isArray(body['functions'])) refuse('client_tools_are_invalid');
    for (const fn of body['functions']) {
      if (!isPlainRecord(fn)) refuse('client_tools_are_invalid');
      assertExactKeys(fn, new Set(['name', 'description', 'parameters']));
      if (typeof fn['name'] !== 'string') refuse('client_tools_are_invalid');
      if (fn['parameters'] !== undefined && !isPlainRecord(fn['parameters'])) {
        refuse('client_tools_are_invalid');
      }
    }
  }
}

function validateRequestOptions(value: unknown): Record<string, unknown> {
  if (value === undefined) return { maxRetries: 0 };
  let options: Record<string, unknown>;
  try {
    options = snapshotOwnDataProperties(PROVIDER, value);
  } catch {
    refuse('request_options_are_invalid');
  }
  assertExactKeys(options, REQUEST_OPTION_KEYS);
  if (options['maxRetries'] !== undefined && options['maxRetries'] !== 0) {
    refuse('provider_retries_must_be_disabled');
  }
  if (
    options['timeout'] !== undefined &&
    (!Number.isFinite(options['timeout']) || (options['timeout'] as number) <= 0)
  ) {
    refuse('request_options_are_invalid');
  }
  const signal = options['signal'] as AbortSignal | undefined;
  if (validatedSignalIsAborted(signal)) refuse('request_aborted_before_reserve');
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(options['timeout'] !== undefined ? { timeout: options['timeout'] } : {}),
    maxRetries: 0,
  };
}

function validatedSignalIsAborted(value: unknown, local = true): boolean {
  if (value === undefined) return false;
  try {
    return abortSignalIsAborted(PROVIDER, value);
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) refuse(error.reason, local);
    throw error;
  }
}

function validateAndNormalizeRequest(value: unknown): {
  body: Record<string, unknown>;
  model: string;
  maxOutputTokens: number;
  inputBound: number;
  stream: boolean;
} {
  let request: Record<string, unknown>;
  try {
    const snapshot = detachValidatedJson(PROVIDER, value).value;
    if (!isPlainRecord(snapshot)) refuse('request_must_be_a_plain_object');
    request = snapshot;
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) refuse(error.reason);
    throw error;
  }
  assertExactKeys(request, TOP_LEVEL_KEYS);
  if (typeof request['model'] !== 'string' || request['model'].length === 0) {
    refuse('model_is_required');
  }
  validateMessages(request['messages']);
  validateClientTools(request);
  if (request['n'] !== undefined && request['n'] !== null && request['n'] !== 1) {
    refuse('multiple_completions_are_unsupported');
  }
  if (
    request['service_tier'] !== undefined &&
    request['service_tier'] !== null &&
    request['service_tier'] !== 'default'
  ) {
    refuse('non_standard_service_tier_is_unsupported');
  }
  const hasCompletionCap = request['max_completion_tokens'] !== undefined;
  const hasLegacyCap = request['max_tokens'] !== undefined;
  if (hasCompletionCap === hasLegacyCap) refuse('exactly_one_output_token_cap_is_required');
  const maxOutputTokens = positiveUint32(
    hasCompletionCap ? request['max_completion_tokens'] : request['max_tokens'],
    'output_token_cap_is_invalid',
  );
  const stream = request['stream'] === true;
  if (
    request['stream'] !== undefined &&
    request['stream'] !== null &&
    typeof request['stream'] !== 'boolean'
  ) {
    refuse('stream_flag_is_invalid');
  }
  if (request['stream_options'] !== undefined) {
    if (!stream || !isPlainRecord(request['stream_options'])) refuse('stream_options_are_invalid');
    assertExactKeys(request['stream_options'], new Set(['include_usage']));
    if (request['stream_options']['include_usage'] !== true) refuse('stream_usage_must_be_enabled');
  }

  const normalizedBody: Record<string, unknown> = {
    ...request,
    n: 1,
    service_tier: 'default',
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  const detachedBody = detachValidatedJson(PROVIDER, normalizedBody);
  if (!isPlainRecord(detachedBody.value)) refuse('request_must_be_a_plain_object');
  const body = detachedBody.value;
  const inputBound = detachedBody.tokenUpperBound;
  if (inputBound >= 1_024) refuse('sub_1024_prompt_bound_is_required');
  return {
    body,
    model: request['model'],
    maxOutputTokens,
    inputBound,
    stream,
  };
}

const OPENAI_BASE_USAGE_KEYS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
]);
const OPENAI_BASE_COMPLETION_DETAIL_KEYS = new Set([
  'accepted_prediction_tokens',
  'reasoning_tokens',
  'rejected_prediction_tokens',
  'text_tokens',
]);
const OPENAI_SEPARATELY_PRICED_DETAIL_KEYS = new Set([
  'audio_tokens',
  'cached_tokens',
  'cache_write_tokens',
  'cache_creation_tokens',
]);

function optionalTokenCountIsValid(value: unknown): boolean {
  return (
    value === undefined || value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function zeroPaidEvidence(value: unknown, depth = 0, seen: Set<object> = new Set()): boolean {
  if (value === undefined || value === null || value === 0 || value === false || value === '') {
    return true;
  }
  if (depth >= 8 || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 256) return false;
    return value.every((entry) => zeroPaidEvidence(entry, depth + 1, seen));
  }
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > 256) return false;
  return keys.every((key) => zeroPaidEvidence(value[key], depth + 1, seen));
}

function openAiUsageDetailsAreBaseOnly(
  value: unknown,
  baseKeys: ReadonlySet<string>,
  aggregate: unknown,
): boolean {
  if (value === undefined || value === null) return true;
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > 256) return false;
  for (const key of keys) {
    const entry = value[key];
    if (baseKeys.has(key)) {
      if (!optionalTokenCountIsValid(entry)) return false;
      if (
        entry !== undefined &&
        entry !== null &&
        (!Number.isSafeInteger(aggregate) || (entry as number) > (aggregate as number))
      ) {
        return false;
      }
      continue;
    }
    if (OPENAI_SEPARATELY_PRICED_DETAIL_KEYS.has(key)) {
      if (!zeroPaidEvidence(entry)) return false;
      continue;
    }
    // Usage-detail fields are a billing evidence surface. A future or custom
    // non-zero field is unsafe until the ledger can price it explicitly.
    if (!zeroPaidEvidence(entry)) return false;
  }
  return true;
}

function openAiUsageIsBaseOnly(usage: Record<string, unknown>): boolean {
  const keys = Object.keys(usage);
  if (keys.length > 256) return false;
  const promptTokens = usage['prompt_tokens'];
  const inputTokens = usage['input_tokens'];
  const completionTokens = usage['completion_tokens'];
  const outputTokens = usage['output_tokens'];
  const exactInput = promptTokens ?? inputTokens;
  const exactOutput = completionTokens ?? outputTokens;
  for (const key of keys) {
    const entry = usage[key];
    if (OPENAI_BASE_USAGE_KEYS.has(key)) {
      if (!optionalTokenCountIsValid(entry)) return false;
      continue;
    }
    if (key === 'prompt_tokens_details' || key === 'input_tokens_details') {
      if (!openAiUsageDetailsAreBaseOnly(entry, new Set(), exactInput)) return false;
      continue;
    }
    if (key === 'completion_tokens_details' || key === 'output_tokens_details') {
      if (!openAiUsageDetailsAreBaseOnly(entry, OPENAI_BASE_COMPLETION_DETAIL_KEYS, exactOutput))
        return false;
      continue;
    }
    if (key === 'service_tier') {
      if (entry !== undefined && entry !== null && entry !== 'default') return false;
      continue;
    }
    // Unknown non-zero top-level usage is potentially separately billed.
    if (!zeroPaidEvidence(entry)) return false;
  }
  if (
    promptTokens !== undefined &&
    promptTokens !== null &&
    inputTokens !== undefined &&
    inputTokens !== null &&
    promptTokens !== inputTokens
  ) {
    return false;
  }
  if (
    completionTokens !== undefined &&
    completionTokens !== null &&
    outputTokens !== undefined &&
    outputTokens !== null &&
    completionTokens !== outputTokens
  ) {
    return false;
  }
  const totalTokens = usage['total_tokens'];
  if (
    totalTokens !== undefined &&
    totalTokens !== null &&
    (!Number.isSafeInteger(exactInput) ||
      !Number.isSafeInteger(exactOutput) ||
      totalTokens !== (exactInput as number) + (exactOutput as number))
  ) {
    return false;
  }
  return true;
}

function exactUsage(value: unknown, expectedModel: string): ExactUsage {
  if (!isPlainRecord(value)) refuseEvidence('response_is_invalid');
  if (value['model'] !== expectedModel)
    refuseEvidence('response_model_did_not_match_reserved_model');
  if (value['service_tier'] !== undefined && value['service_tier'] !== 'default') {
    refuseEvidence('response_did_not_prove_standard_tier');
  }
  const usage = value['usage'];
  if (!isPlainRecord(usage)) refuseEvidence('response_missing_exact_usage');
  const inputTokens = usage['prompt_tokens'];
  const outputTokens = usage['completion_tokens'];
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    (inputTokens as number) > 4_294_967_295 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0 ||
    (outputTokens as number) > 4_294_967_295
  ) {
    refuseEvidence('response_missing_exact_usage');
  }
  if (!openAiUsageIsBaseOnly(usage)) refuseEvidence('response_used_unsupported_paid_feature');
  return { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

function emitLegacy(
  attempt: ControlledAttemptHandle,
  response: unknown,
  usage: ExactUsage,
  startedAt: number,
  status: (typeof EventStatus)[keyof typeof EventStatus] = EventStatus.SUCCESS,
): void {
  if (!attempt.legacyTelemetryRequired || !attempt.identityIsCurrent()) return;
  const record = isPlainRecord(response) ? response : {};
  try {
    enqueue(
      buildLlmEvent({
        provider: Provider.OPENAI,
        model: typeof record['model'] === 'string' ? record['model'] : null,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        latencyMs: Math.max(0, Date.now() - startedAt),
        status,
        tokenCountSource: TokenCountSource.EXACT,
      }),
    );
  } catch {
    // Legacy telemetry has always been non-fatal.
  }
}

type LegacyEmitter = (
  attempt: ControlledAttemptHandle,
  response: unknown,
  usage: ExactUsage,
  status?: (typeof EventStatus)[keyof typeof EventStatus],
) => void;

async function settleResponse(
  response: unknown,
  attempt: ControlledAttemptHandle,
  startedAt: number,
  expectedModel: string,
  legacyEmitter: LegacyEmitter,
): Promise<void> {
  try {
    const usage = exactUsage(response, expectedModel);
    if (attempt.ownsReservation) {
      await attempt.settleExact({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: Math.max(0, Date.now() - startedAt),
      });
    } else {
      legacyEmitter(attempt, response, usage);
    }
  } catch {
    // Provider success wins. Missing/conflicting paid-feature evidence leaves
    // the reservation unresolved for replay/expiry and emits no legacy guess.
  }
}

function openAiStreamObserver(
  startedAt: number,
  expectedModel: string,
  legacyEmitter: LegacyEmitter,
) {
  let terminal: unknown = null;
  let invalid = false;
  return {
    observe(chunk: unknown): void {
      try {
        if (!isPlainRecord(chunk)) {
          invalid = true;
          return;
        }
        if (chunk['service_tier'] !== undefined && chunk['service_tier'] !== 'default') {
          invalid = true;
        }
        if (chunk['model'] !== undefined && chunk['model'] !== expectedModel) invalid = true;
        if (chunk['usage'] !== undefined && chunk['usage'] !== null) {
          if (terminal !== null) invalid = true;
          else {
            const usage = exactUsage(chunk, expectedModel);
            terminal = Object.freeze({
              model: expectedModel,
              service_tier: 'default',
              usage: Object.freeze({
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
              }),
            });
          }
        }
      } catch {
        // A hostile/custom response getter is unsafe pricing evidence. Keep
        // the provider chunk visible, but permanently poison settlement.
        invalid = true;
      }
    },
    async settle(attempt: ControlledAttemptHandle): Promise<void> {
      if (terminal === null || invalid) return;
      await settleResponse(terminal, attempt, startedAt, expectedModel, legacyEmitter);
    },
  };
}

function controlledCreate(
  dispatch: () => Promise<IsolatedOpenAIDispatch>,
  lifecycle: FacadeLifecycle,
  options: StrictOpenAIOptions,
  args: unknown[],
): DeferredControlledPromise<unknown> {
  if (lifecycle.isClosed()) refuse('client_is_closed');
  if (args.length < 1 || args.length > 2) refuse('create_arguments_are_invalid');
  const normalized = validateAndNormalizeRequest(args[0]);
  const requestOptions = validateRequestOptions(args[1]);
  const startedAt = Date.now();
  let legacyTerminalEmitted = false;
  const emitLegacyOnce: LegacyEmitter = (attempt, response, usage, status) => {
    if (legacyTerminalEmitted) return;
    if (!attempt.legacyTelemetryRequired || !attempt.identityIsCurrent()) return;
    legacyTerminalEmitted = true;
    emitLegacy(attempt, response, usage, startedAt, status);
  };
  const launched = dispatch().then((isolated) => {
    if (lifecycle.isClosed()) refuse('client_is_closed');
    return executeControlledAttempt<ProviderPromiseLike<unknown>>({
      provider: Provider.OPENAI,
      model: normalized.model,
      estimatedInputTokens: normalized.inputBound,
      maxOutputTokens: normalized.maxOutputTokens,
      ...options,
      predispatchCheck: () => {
        if (lifecycle.isClosed()) refuse('client_is_closed', false);
        if (validatedSignalIsAborted(requestOptions['signal'], false)) {
          refuse('request_aborted_before_provider_dispatch', false);
        }
        try {
          assertJsonSerializationPosture(PROVIDER);
        } catch (error) {
          if (error instanceof PylvaStrictProviderError) refuse(error.reason, false);
          throw error;
        }
      },
      dispatchThrew: (_error, attempt) => {
        emitLegacyOnce(
          attempt,
          { model: normalized.model },
          { inputTokens: 0, outputTokens: 0 },
          EventStatus.FAILURE,
        );
      },
      dispatch: () => isolated.invoke(normalized.body, requestOptions),
    });
  });
  return new DeferredControlledPromise(launched, {
    async transform(response, attempt) {
      if (normalized.stream) {
        if (typeof response !== 'object' || response === null) return response;
        return wrapControlledAsyncStream(
          response,
          attempt,
          openAiStreamObserver(startedAt, normalized.model, emitLegacyOnce),
          {
            signal: requestOptions['signal'] as AbortSignal | undefined,
            subscribeCancellation: lifecycle.subscribeCancellation,
          },
        );
      }
      await settleResponse(response, attempt, startedAt, normalized.model, emitLegacyOnce);
      return response;
    },
    providerRejected(_error, attempt) {
      emitLegacyOnce(
        attempt,
        { model: normalized.model },
        { inputTokens: 0, outputTokens: 0 },
        EventStatus.FAILURE,
      );
    },
    async rawJson(response, attempt) {
      if (!normalized.stream) {
        await settleResponse(response, attempt, startedAt, normalized.model, emitLegacyOnce);
      }
    },
  });
}

/**
 * Explicit authoritative OpenAI Chat Completions surface.
 *
 * It intentionally does not monkey-patch the client. Only
 * `chat.completions.create` is controlled; every other resource is unchanged.
 */
function wrapOpenAIInternal<T extends object>(
  client: T,
  options: StrictOpenAIOptions,
  officialConstructor: OfficialConstructor | null,
  trustedCallerConstructor: OfficialConstructor | null = officialConstructor,
): T {
  const candidate = client as T & Partial<OpenAIClientShape>;
  let resource: OpenAIResource | undefined;
  let createMethod: OpenAIResource['create'] | null = null;
  let callableCreate = false;
  try {
    const baseURL = propertyIdentity(candidate, 'baseURL').value;
    if (typeof baseURL !== 'string' || baseURL.replace(/\/+$/, '') !== OPENAI_BASE_URL) {
      refuse('official_provider_endpoint_is_required');
    }
    const chat = propertyIdentity(candidate, 'chat').value;
    if (typeof chat !== 'object' || chat === null || isProxyObject(chat)) {
      refuse('chat_completions_are_unavailable');
    }
    const resourceValue = propertyIdentity(chat, 'completions').value;
    if (typeof resourceValue === 'object' && resourceValue !== null) {
      resource = resourceValue as OpenAIResource;
      const create = propertyIdentity(resource, 'create').value;
      if (typeof create === 'function') {
        callableCreate = true;
        createMethod = create as OpenAIResource['create'];
      }
    }
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) throw error;
    refuse('invalid_client');
  }
  if (!resource || !callableCreate) refuse('chat_completions_are_unavailable');
  if (createMethod === null) refuse('chat_completions_are_unavailable');
  const posture = captureClientPosture(candidate, resource, officialConstructor !== null);
  assertClientPosture(candidate, resource, posture);
  if (officialConstructor !== null) {
    if (trustedCallerConstructor === null) refuse('invalid_client');
    assertOfficialIdentity(candidate, resource, createMethod, trustedCallerConstructor);
  }
  const isolated = isolateDispatch(
    candidate,
    resource,
    officialConstructor,
    trustedCallerConstructor,
  );
  const dispatch = (): Promise<IsolatedOpenAIDispatch> => Promise.resolve(isolated);
  const privateClose =
    isolated.client === null ? undefined : propertyIdentity(isolated.client, 'close').value;
  const lifecycle = createControlledStreamLifecycle(() =>
    typeof privateClose === 'function' ? privateClose.call(isolated.client) : undefined,
  );
  const create = (...args: unknown[]) => controlledCreate(dispatch, lifecycle, options, args);
  const controlledResource = strictFacade(
    new Map<string | symbol, unknown>([
      ['create', create],
      [Symbol.toStringTag, 'PylvaControlledOpenAICompletions'],
    ]),
  );
  const controlledChat = strictFacade(
    new Map<string | symbol, unknown>([
      ['completions', controlledResource],
      [Symbol.toStringTag, 'PylvaControlledOpenAIChat'],
    ]),
  );
  const rootEntries = new Map<string | symbol, unknown>([
    ['chat', controlledChat],
    ['maxRetries', 0],
    [Symbol.toStringTag, 'PylvaControlledOpenAI'],
  ]);
  rootEntries.set('close', lifecycle.close);
  return strictFacade(rootEntries) as T;
}

export async function wrapOpenAI<T extends object>(
  client: T,
  options: StrictOpenAIOptions = {},
): Promise<ControlledOpenAIClient<T>> {
  let peer: typeof import('openai');
  let version: typeof import('openai/version');
  try {
    [peer, version] = await Promise.all([import('openai'), import('openai/version')]);
  } catch {
    refuse('invalid_client');
  }
  if (!supportedOpenAIVersion(version.VERSION)) refuse('unsupported_provider_sdk_version');
  const constructor = peer.OpenAI ?? peer.default;
  if (typeof constructor !== 'function') refuse('invalid_client');
  let candidatePrototype: object | null;
  try {
    if (isProxyObject(client)) refuse('invalid_client');
    candidatePrototype = Object.getPrototypeOf(client) as object | null;
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) throw error;
    refuse('invalid_client');
  }
  const trustedCallerConstructor =
    candidatePrototype === constructor.prototype
      ? (constructor as OfficialConstructor)
      : validatedCommonJsConstructor(candidatePrototype);
  if (trustedCallerConstructor === null) refuse('invalid_client');
  return wrapOpenAIInternal(
    client,
    options,
    constructor as OfficialConstructor,
    trustedCallerConstructor,
  ) as ControlledOpenAIClient<T>;
}

/** @internal Structural test seam; never exported from a public package entrypoint. */
export function _wrapOpenAIForTests<T extends object>(
  client: T,
  options: StrictOpenAIOptions = {},
): T {
  return wrapOpenAIInternal(client, options, null);
}

export { PylvaStrictProviderError } from '../errors/strict_provider.js';
