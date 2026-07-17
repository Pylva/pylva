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
  assertNoNestedKeys,
  detachValidatedJson,
  isPlainRecord,
  isProxyObject,
  snapshotOwnDataProperties,
} from './_usage_bound.js';
import { originalProviderMethod } from './_strict_unwrap.js';

const PROVIDER = 'anthropic' as const;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const MAX_STANDARD_INPUT_BOUND = 200_000;
const TOP_LEVEL_KEYS = new Set([
  'model',
  'messages',
  'max_tokens',
  'system',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stream',
  'service_tier',
  'metadata',
]);
const FORBIDDEN_NESTED_KEYS = new Set([
  'cache_control',
  'cache_creation',
  'cache_retention',
  'server_tool_use',
]);
const REQUEST_OPTION_KEYS = new Set(['signal', 'timeout', 'maxRetries', 'headers']);

type OfficialConstructor = (new (options: Record<string, unknown>) => object) & Function;

function supportedAnthropicVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 0 && (minor > 30 || (minor === 30 && patch >= 1));
}

export interface StrictAnthropicOptions extends ControlledAttemptOptions {}

type AnthropicCreateMethod<T> = T extends { messages: { create: infer TCreate } } ? TCreate : never;

type AnthropicStreamMethod<T> = T extends { messages: { stream: infer TStream } } ? TStream : never;

type AnthropicCloseMethod<T> = T extends { close: infer TClose } ? TClose : () => unknown;

export interface ControlledAnthropicClient<TClient extends object> {
  readonly maxRetries: 0;
  readonly messages: {
    readonly create: AnthropicCreateMethod<TClient>;
    readonly stream: AnthropicStreamMethod<TClient>;
  };
  readonly close: AnthropicCloseMethod<TClient>;
}

interface AnthropicResource {
  _client?: unknown;
  create(body: unknown, options?: unknown): ProviderPromiseLike<unknown>;
  stream?(body: unknown, options?: unknown): unknown;
}

interface AnthropicClientShape {
  apiKey?: unknown;
  authToken?: unknown;
  baseURL: string;
  fetch?: unknown;
  maxRetries: number;
  timeout?: unknown;
  fetchOptions?: unknown;
  _options?: {
    defaultHeaders?: unknown;
    defaultQuery?: unknown;
    fetch?: unknown;
    fetchOptions?: unknown;
  };
  messages: AnthropicResource;
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

interface IsolatedAnthropicDispatch {
  client: Partial<AnthropicClientShape> | null;
  resource: AnthropicResource;
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
  candidate: Partial<AnthropicClientShape>,
  resource: AnthropicResource,
  allowOfficialBundledFetch = false,
): CapturedClientPosture {
  const create = propertyIdentity(resource, 'create');
  const fetch = propertyIdentity(candidate, 'fetch');
  const resourceClient = propertyIdentity(resource, '_client');
  if (typeof create.value !== 'function') refuse('messages_are_unavailable');
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
  candidate: Partial<AnthropicClientShape>,
  trustedCallerConstructor: OfficialConstructor,
): void {
  let probe: Partial<AnthropicClientShape>;
  try {
    probe = Reflect.construct(trustedCallerConstructor, [
      {
        apiKey: 'pylva-posture-probe',
        baseURL: ANTHROPIC_BASE_URL,
        maxRetries: 0,
      },
    ]) as Partial<AnthropicClientShape>;
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
    const resolved = require.resolve('@anthropic-ai/sdk');
    const peer = require('@anthropic-ai/sdk') as { default?: unknown; Anthropic?: unknown };
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
    for (const constructor of [peer.Anthropic, peer.default]) {
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

function ownClientValue(candidate: Partial<AnthropicClientShape>, key: PropertyKey): unknown {
  const identity = propertyIdentity(candidate, key);
  if (identity.owner !== null && identity.owner !== candidate) refuse('invalid_client');
  return identity.value;
}

function cloneFallbackDispatchResource(
  candidate: Partial<AnthropicClientShape>,
  resource: AnthropicResource,
): AnthropicResource {
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
    const resourceClone = Object.create(Object.getPrototypeOf(resource)) as AnthropicResource;
    Object.defineProperties(resourceClone, descriptors);
    return resourceClone;
  } catch {
    refuse('invalid_client');
  }
}

function isolateDispatch(
  candidate: Partial<AnthropicClientShape>,
  resource: AnthropicResource,
  officialConstructor: OfficialConstructor | null,
  trustedCallerConstructor: OfficialConstructor | null,
): IsolatedAnthropicDispatch {
  let isolatedClient: Partial<AnthropicClientShape> | null = null;
  let isolatedResource: AnthropicResource;
  if (officialConstructor !== null) {
    if (trustedCallerConstructor === null) refuse('invalid_client');
    assertMatchesTrustedDefaultFetch(candidate, trustedCallerConstructor);
    const apiKey = ownClientValue(candidate, 'apiKey');
    const authToken = ownClientValue(candidate, 'authToken');
    const timeout = ownClientValue(candidate, 'timeout');
    if (
      (apiKey !== undefined && apiKey !== null && typeof apiKey !== 'string') ||
      (authToken !== undefined && authToken !== null && typeof authToken !== 'string') ||
      (typeof apiKey !== 'string' && typeof authToken !== 'string') ||
      (timeout !== undefined && (!Number.isFinite(timeout) || (timeout as number) <= 0))
    ) {
      refuse('invalid_client');
    }
    try {
      isolatedClient = Reflect.construct(officialConstructor, [
        {
          ...(typeof apiKey === 'string' ? { apiKey } : {}),
          ...(typeof authToken === 'string' ? { authToken } : {}),
          baseURL: ANTHROPIC_BASE_URL,
          maxRetries: 0,
          ...(timeout !== undefined ? { timeout } : {}),
        },
      ]) as Partial<AnthropicClientShape>;
      isolatedResource = isolatedClient.messages as AnthropicResource;
    } catch (error) {
      if (error instanceof PylvaStrictProviderError) throw error;
      refuse('invalid_client');
    }
  } else {
    isolatedResource = cloneFallbackDispatchResource(candidate, resource);
  }
  let invoke: AnthropicResource['create'] | null = null;
  try {
    if (!isolatedResource) refuse('invalid_client');
    if (isolatedClient !== null) {
      const post = propertyIdentity(isolatedClient, 'post').value;
      if (typeof post !== 'function') refuse('invalid_client');
      invoke = (body: unknown, options?: unknown) =>
        post.call(isolatedClient, '/v1/messages', {
          body,
          ...(isPlainRecord(options) ? options : {}),
          stream: isPlainRecord(body) && body['stream'] === true,
        }) as ProviderPromiseLike<unknown>;
    } else {
      const create = propertyIdentity(isolatedResource, 'create').value;
      if (typeof create !== 'function') refuse('invalid_client');
      const original = originalProviderMethod(create as AnthropicResource['create']);
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
  candidate: Partial<AnthropicClientShape>,
  resource: AnthropicResource,
  create: AnthropicResource['create'],
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
    const resourceConstructor = Object.getOwnPropertyDescriptor(constructor, 'Messages')?.value;
    if (
      typeof resourceConstructor !== 'function' ||
      Object.getPrototypeOf(resource) !== resourceConstructor.prototype ||
      Object.prototype.hasOwnProperty.call(resource, 'create') ||
      Object.prototype.hasOwnProperty.call(resource, 'stream')
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
  candidate: Partial<AnthropicClientShape>,
  resource: AnthropicResource,
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
      if (typeof baseURL !== 'string' || baseURL.replace(/\/+$/, '') !== ANTHROPIC_BASE_URL) {
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
        const current = propertyIdentity(resource, 'create', local).value;
        const fetch = propertyIdentity(candidate, 'fetch', local);
        const resourceClient = propertyIdentity(resource, '_client', local);
        if (
          propertyIdentity(candidate, 'messages', local).value !== resource ||
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

function validateTextBlock(value: unknown): void {
  if (!isPlainRecord(value)) refuse('messages_must_be_text_only');
  assertExactKeys(value, new Set(['type', 'text', 'citations']));
  if (value['type'] !== 'text' || typeof value['text'] !== 'string') {
    refuse('messages_must_be_text_only');
  }
  if (value['citations'] !== undefined) refuse('remote_content_features_are_unsupported');
}

function validateToolUseBlock(value: Record<string, unknown>): void {
  assertExactKeys(value, new Set(['type', 'id', 'name', 'input']));
  if (
    value['type'] !== 'tool_use' ||
    typeof value['id'] !== 'string' ||
    typeof value['name'] !== 'string' ||
    !isPlainRecord(value['input'])
  ) {
    refuse('client_tool_block_is_invalid');
  }
}

function validateToolResultBlock(value: Record<string, unknown>): void {
  assertExactKeys(value, new Set(['type', 'tool_use_id', 'content', 'is_error']));
  if (value['type'] !== 'tool_result' || typeof value['tool_use_id'] !== 'string') {
    refuse('client_tool_block_is_invalid');
  }
  const content = value['content'];
  if (typeof content !== 'string') {
    if (!Array.isArray(content)) refuse('client_tool_block_is_invalid');
    for (const item of content) validateTextBlock(item);
  }
  if (value['is_error'] !== undefined && typeof value['is_error'] !== 'boolean') {
    refuse('client_tool_block_is_invalid');
  }
}

function validateContent(value: unknown): void {
  if (typeof value === 'string') return;
  if (!Array.isArray(value) || value.length === 0) refuse('messages_are_required');
  for (const block of value) {
    if (!isPlainRecord(block)) refuse('message_block_is_invalid');
    if (block['type'] === 'text') validateTextBlock(block);
    else if (block['type'] === 'tool_use') validateToolUseBlock(block);
    else if (block['type'] === 'tool_result') validateToolResultBlock(block);
    else refuse('remote_media_or_server_tool_is_unsupported');
  }
}

function validateMessages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) refuse('messages_are_required');
  for (const message of value) {
    if (!isPlainRecord(message)) refuse('message_is_invalid');
    assertExactKeys(message, new Set(['role', 'content']));
    if (message['role'] !== 'user' && message['role'] !== 'assistant') {
      refuse('message_role_is_unsupported');
    }
    validateContent(message['content']);
  }
}

function validateSystem(value: unknown): void {
  if (value === undefined || typeof value === 'string') return;
  if (!Array.isArray(value)) refuse('system_prompt_must_be_text_only');
  for (const block of value) validateTextBlock(block);
}

function validateClientTools(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) refuse('client_tools_are_invalid');
  for (const tool of value) {
    if (!isPlainRecord(tool)) refuse('client_tools_are_invalid');
    assertExactKeys(
      tool,
      new Set(['type', 'name', 'description', 'input_schema', 'input_examples', 'strict']),
    );
    if (tool['type'] !== undefined && tool['type'] !== 'custom') {
      refuse('remote_or_server_tools_are_unsupported');
    }
    if (typeof tool['name'] !== 'string' || !isPlainRecord(tool['input_schema'])) {
      refuse('client_tools_are_invalid');
    }
    if (tool['description'] !== undefined && typeof tool['description'] !== 'string') {
      refuse('client_tools_are_invalid');
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
  let headers: Record<string, unknown> | undefined;
  if (options['headers'] !== undefined) {
    try {
      headers = snapshotOwnDataProperties(PROVIDER, options['headers']);
    } catch {
      refuse('request_options_are_invalid');
    }
    const keys = Object.keys(headers);
    if (
      keys.length !== 1 ||
      keys[0] !== 'X-Stainless-Helper-Method' ||
      headers['X-Stainless-Helper-Method'] !== 'stream'
    ) {
      refuse('custom_request_headers_are_unsupported');
    }
  }
  return {
    ...(signal !== undefined ? { signal } : {}),
    ...(options['timeout'] !== undefined ? { timeout: options['timeout'] } : {}),
    ...(headers !== undefined ? { headers: { 'X-Stainless-Helper-Method': 'stream' } } : {}),
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
    assertNoNestedKeys(PROVIDER, request, FORBIDDEN_NESTED_KEYS);
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) refuse(error.reason);
    throw error;
  }
  assertExactKeys(request, TOP_LEVEL_KEYS);
  if (typeof request['model'] !== 'string' || request['model'].length === 0) {
    refuse('model_is_required');
  }
  const maxOutputTokens = positiveUint32(request['max_tokens'], 'output_token_cap_is_invalid');
  validateMessages(request['messages']);
  validateSystem(request['system']);
  validateClientTools(request['tools']);
  if (
    request['service_tier'] !== undefined &&
    request['service_tier'] !== null &&
    request['service_tier'] !== 'standard_only'
  ) {
    refuse('non_standard_service_tier_is_unsupported');
  }
  if (request['stream'] !== undefined && typeof request['stream'] !== 'boolean') {
    refuse('stream_flag_is_invalid');
  }
  const detachedBody = detachValidatedJson(PROVIDER, {
    ...request,
    service_tier: 'standard_only',
  });
  if (!isPlainRecord(detachedBody.value)) refuse('request_must_be_a_plain_object');
  const body = detachedBody.value;
  const inputBound = detachedBody.tokenUpperBound;
  if (inputBound >= MAX_STANDARD_INPUT_BOUND) refuse('long_context_pricing_is_unsupported');
  return {
    body,
    model: request['model'],
    maxOutputTokens,
    inputBound,
    stream: request['stream'] === true,
  };
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

function anthropicUsageIsBaseOnly(usage: Record<string, unknown>): boolean {
  const keys = Object.keys(usage);
  if (keys.length > 256) return false;
  const outputTokens = usage['output_tokens'];
  for (const key of keys) {
    const entry = usage[key];
    if (key === 'input_tokens' || key === 'output_tokens') {
      if (
        entry !== undefined &&
        entry !== null &&
        (!Number.isSafeInteger(entry) || (entry as number) < 0)
      ) {
        return false;
      }
      continue;
    }
    if (key === 'service_tier') {
      if (entry !== undefined && entry !== null && entry !== 'standard') return false;
      continue;
    }
    if (key === 'inference_geo') {
      if (entry !== undefined && entry !== null && typeof entry !== 'string') return false;
      continue;
    }
    if (key === 'output_tokens_details') {
      if (!isPlainRecord(entry)) {
        if (entry !== undefined && entry !== null) return false;
        continue;
      }
      const detailKeys = Object.keys(entry);
      if (detailKeys.length > 256) return false;
      for (const detailKey of detailKeys) {
        const detail = entry[detailKey];
        if (detailKey === 'thinking_tokens') {
          if (
            detail !== undefined &&
            detail !== null &&
            (!Number.isSafeInteger(detail) ||
              (detail as number) < 0 ||
              !Number.isSafeInteger(outputTokens) ||
              (detail as number) > (outputTokens as number))
          ) {
            return false;
          }
        } else if (!zeroPaidEvidence(detail)) {
          return false;
        }
      }
      continue;
    }
    if (!zeroPaidEvidence(entry)) return false;
  }
  return true;
}

function exactUsage(value: unknown, expectedModel: string): ExactUsage {
  if (!isPlainRecord(value)) refuseEvidence('response_is_invalid');
  if (value['model'] !== expectedModel)
    refuseEvidence('response_model_did_not_match_reserved_model');
  const usage = value['usage'];
  if (!isPlainRecord(usage)) refuseEvidence('response_missing_exact_usage');
  const serviceTier = value['service_tier'] ?? usage['service_tier'];
  if (serviceTier !== undefined && serviceTier !== null && serviceTier !== 'standard') {
    refuseEvidence('response_did_not_prove_standard_tier');
  }
  const inputTokens = usage['input_tokens'];
  const outputTokens = usage['output_tokens'];
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
  if (!anthropicUsageIsBaseOnly(usage)) refuseEvidence('response_used_non_base_pricing');
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
        provider: Provider.ANTHROPIC,
        model: typeof record['model'] === 'string' ? record['model'] : null,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
        latencyMs: Math.max(0, Date.now() - startedAt),
        status,
        tokenCountSource: TokenCountSource.EXACT,
      }),
    );
  } catch {
    // Legacy telemetry remains non-fatal.
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
    // Provider success wins; unsafe evidence leaves control unresolved.
  }
}

function anthropicStreamObserver(
  startedAt: number,
  expectedModel: string,
  legacyEmitter: LegacyEmitter,
) {
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let model: string | null = null;
  let serviceTier: unknown;
  let cacheCreation: unknown;
  let cacheCreationDetail: unknown;
  let cacheRead: unknown;
  let serverToolUse: unknown;
  let invalid = false;
  let messageStarted = false;
  const mergeInputTokens = (value: unknown): void => {
    if (!Number.isSafeInteger(value)) return;
    const count = value as number;
    if (inputTokens !== null && inputTokens !== count) invalid = true;
    else inputTokens = count;
  };
  const mergeOutputTokens = (value: unknown): void => {
    if (!Number.isSafeInteger(value)) return;
    const count = value as number;
    if (outputTokens !== null && count < outputTokens) invalid = true;
    outputTokens = outputTokens === null ? count : Math.max(outputTokens, count);
  };
  return {
    observe(event: unknown): void {
      try {
        if (!isPlainRecord(event)) {
          invalid = true;
          return;
        }
        if (event['type'] === 'message_start' && isPlainRecord(event['message'])) {
          if (messageStarted) invalid = true;
          messageStarted = true;
          const message = event['message'];
          model = typeof message['model'] === 'string' ? message['model'] : null;
          serviceTier = message['service_tier'];
          if (isPlainRecord(message['usage'])) {
            const usage = message['usage'];
            if (!anthropicUsageIsBaseOnly(usage)) invalid = true;
            mergeInputTokens(usage['input_tokens']);
            mergeOutputTokens(usage['output_tokens']);
            serviceTier = usage['service_tier'] ?? message['service_tier'];
            cacheCreation = usage['cache_creation_input_tokens'];
            cacheCreationDetail = usage['cache_creation'];
            cacheRead = usage['cache_read_input_tokens'];
            serverToolUse = usage['server_tool_use'];
          }
        }
        if (event['type'] === 'content_block_start' && isPlainRecord(event['content_block'])) {
          const blockType = event['content_block']['type'];
          if (
            typeof blockType !== 'string' ||
            /server|web_search|web_fetch|code_execution|mcp/i.test(blockType)
          ) {
            invalid = true;
          }
        }
        if (event['type'] === 'message_delta' && isPlainRecord(event['usage'])) {
          const usage = event['usage'];
          if (!anthropicUsageIsBaseOnly(usage)) invalid = true;
          mergeInputTokens(usage['input_tokens']);
          mergeOutputTokens(usage['output_tokens']);
          if (usage['cache_creation_input_tokens'] !== undefined) {
            cacheCreation = usage['cache_creation_input_tokens'];
          }
          if (usage['cache_creation'] !== undefined) {
            cacheCreationDetail = usage['cache_creation'];
          }
          if (usage['cache_read_input_tokens'] !== undefined)
            cacheRead = usage['cache_read_input_tokens'];
          if (usage['server_tool_use'] !== undefined) serverToolUse = usage['server_tool_use'];
          if (usage['service_tier'] !== undefined) serviceTier = usage['service_tier'];
        }
      } catch {
        // Preserve hostile/custom provider events for the consumer while
        // permanently preventing an exact-cost commit.
        invalid = true;
      }
    },
    async settle(attempt: ControlledAttemptHandle): Promise<void> {
      if (invalid) return;
      await settleResponse(
        {
          model,
          service_tier: serviceTier,
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens: cacheCreation,
            cache_creation: cacheCreationDetail,
            cache_read_input_tokens: cacheRead,
            server_tool_use: serverToolUse,
          },
        },
        attempt,
        startedAt,
        expectedModel,
        legacyEmitter,
      );
    },
  };
}

function controlledCreate(
  dispatch: () => Promise<IsolatedAnthropicDispatch>,
  lifecycle: FacadeLifecycle,
  options: StrictAnthropicOptions,
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
      provider: Provider.ANTHROPIC,
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
          anthropicStreamObserver(startedAt, normalized.model, emitLegacyOnce),
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

/** Explicit authoritative Anthropic Messages surface, including native stream(). */
function wrapAnthropicInternal<T extends object>(
  client: T,
  options: StrictAnthropicOptions,
  officialConstructor: OfficialConstructor | null,
  trustedCallerConstructor: OfficialConstructor | null = officialConstructor,
): T {
  const candidate = client as T & Partial<AnthropicClientShape>;
  let resource: AnthropicResource | undefined;
  let createMethod: AnthropicResource['create'] | null = null;
  let callableCreate = false;
  try {
    const baseURL = propertyIdentity(candidate, 'baseURL').value;
    if (typeof baseURL !== 'string' || baseURL.replace(/\/+$/, '') !== ANTHROPIC_BASE_URL) {
      refuse('official_provider_endpoint_is_required');
    }
    const resourceValue = propertyIdentity(candidate, 'messages').value;
    if (typeof resourceValue === 'object' && resourceValue !== null) {
      resource = resourceValue as AnthropicResource;
      const create = propertyIdentity(resource, 'create').value;
      if (typeof create === 'function') {
        callableCreate = true;
        createMethod = create as AnthropicResource['create'];
      }
    }
  } catch (error) {
    if (error instanceof PylvaStrictProviderError) throw error;
    refuse('invalid_client');
  }
  if (!resource || !callableCreate) refuse('messages_are_unavailable');
  if (createMethod === null) refuse('messages_are_unavailable');
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
  const dispatch = (): Promise<IsolatedAnthropicDispatch> => Promise.resolve(isolated);
  const privateClose =
    isolated.client === null ? undefined : propertyIdentity(isolated.client, 'close').value;
  const lifecycle = createControlledStreamLifecycle(() =>
    typeof privateClose === 'function' ? privateClose.call(isolated.client) : undefined,
  );
  const create = (...args: unknown[]) => controlledCreate(dispatch, lifecycle, options, args);
  const privateStream = propertyIdentity(isolated.resource, 'stream').value;
  const internalMessages = Object.create(null) as Record<PropertyKey, unknown>;
  Object.defineProperties(internalMessages, {
    create: { value: create, enumerable: true, configurable: false, writable: false },
    _client: {
      value: propertyIdentity(isolated.resource, '_client').value,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  const entries = new Map<string | symbol, unknown>([
    ['create', create],
    [Symbol.toStringTag, 'PylvaControlledAnthropicMessages'],
  ]);
  if (typeof privateStream === 'function') {
    entries.set('stream', (...args: unknown[]) => {
      if (lifecycle.isClosed()) refuse('client_is_closed');
      return privateStream.apply(internalMessages, args);
    });
  }
  const controlledResource = strictFacade(entries);
  const rootEntries = new Map<string | symbol, unknown>([
    ['messages', controlledResource],
    ['maxRetries', 0],
    [Symbol.toStringTag, 'PylvaControlledAnthropic'],
  ]);
  rootEntries.set('close', lifecycle.close);
  return strictFacade(rootEntries) as T;
}

export async function wrapAnthropic<T extends object>(
  client: T,
  options: StrictAnthropicOptions = {},
): Promise<ControlledAnthropicClient<T>> {
  let peer: typeof import('@anthropic-ai/sdk');
  let version: typeof import('@anthropic-ai/sdk/version');
  try {
    [peer, version] = await Promise.all([
      import('@anthropic-ai/sdk'),
      import('@anthropic-ai/sdk/version'),
    ]);
  } catch {
    refuse('invalid_client');
  }
  if (!supportedAnthropicVersion(version.VERSION)) {
    refuse('unsupported_provider_sdk_version');
  }
  const constructor = peer.Anthropic ?? peer.default;
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
  return wrapAnthropicInternal(
    client,
    options,
    constructor as OfficialConstructor,
    trustedCallerConstructor,
  ) as ControlledAnthropicClient<T>;
}

/** @internal Structural test seam; never exported from a public package entrypoint. */
export function _wrapAnthropicForTests<T extends object>(
  client: T,
  options: StrictAnthropicOptions = {},
): T {
  return wrapAnthropicInternal(client, options, null);
}

export { PylvaStrictProviderError } from '../errors/strict_provider.js';
