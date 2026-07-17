// Public configuration validation facade over the one canonical, closure-owned
// state and transport runtime. Raw caller objects are fully detached and
// validated here before any identity resetter can run or new credential can be
// published by the canonical runtime.

import { isProxy } from 'node:util/types';
import {
  ControlMode,
  ControlUnavailablePolicy,
  DEFAULT_CONTROL_TIMEOUT_MS,
  InvalidApiKeyError,
  InvalidControlConfigError,
  MAX_CONTROL_TIMEOUT_MS,
  MIN_CONTROL_TIMEOUT_MS,
  _resetCoreRuntimeForTests,
  getConfig as runtimeGetConfig,
  getConfigGeneration as runtimeGetConfigGeneration,
  installResolved,
  isInitialized as runtimeIsInitialized,
  requireConfig as runtimeRequireConfig,
  type InitConfig,
  type ResolvedControlConfig,
  type ResolvedInstallConfig,
  type RuntimeConfig,
} from '../internal/core-runtime-state.js';

export {
  ControlMode,
  ControlUnavailablePolicy,
  DEFAULT_CONTROL_TIMEOUT_MS,
  InvalidApiKeyError,
  InvalidControlConfigError,
  MAX_CONTROL_TIMEOUT_MS,
  MIN_CONTROL_TIMEOUT_MS,
};
export type {
  ControlConfig,
  InitConfig,
  ResolvedConfig,
  ResolvedControlConfig,
} from '../internal/core-runtime-state.js';
export type { RuntimeConfig } from '../internal/core-runtime-state.js';

const API_KEY_PATTERN = /^pv_(?:live|cli)_[a-f0-9]{8}_[a-f0-9]{32}$/;
const DEFAULT_ENDPOINT = 'https://api.pylva.com';
const CONFIG_KEYS = new Set([
  'apiKey',
  'endpoint',
  'batchSize',
  'flushInterval',
  'localMode',
  'nonLlm',
  'control',
]);
const NON_LLM_KEYS = new Set(['mode', 'policy', 'refreshIntervalMs', 'usageExtractors']);
const NON_LLM_POLICY_KEYS = new Set(['unknown_behavior', 'sources']);
const NON_LLM_SOURCE_KEYS = new Set([
  'slug',
  'status',
  'matchers',
  'metric',
  'unit',
  'default_metric_value',
]);
const MAX_NON_LLM_SNAPSHOT_NODES = 10_000;
const MAX_NON_LLM_TEXT_CODE_POINTS = 100;

interface SnapshotBudget {
  readonly seen: Set<object>;
  used: number;
}

export function isValidApiKeyFormat(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey);
}

function normalizeEndpoint(value: unknown): string {
  if (value === undefined) return DEFAULT_ENDPOINT;
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new TypeError('[pylva] endpoint must be an absolute HTTP(S) URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('[pylva] endpoint must be an absolute HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError('[pylva] endpoint must be an absolute HTTP(S) URL without credentials');
  }
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path}`;
}

function resolveControlConfig(value: unknown): ResolvedControlConfig {
  if (value === undefined) {
    return Object.freeze({
      mode: ControlMode.LEGACY,
      onUnavailable: ControlUnavailablePolicy.ALLOW,
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
    });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw new InvalidControlConfigError('control must be an object');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InvalidControlConfigError('control must be a plain object');
  }
  const input = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new InvalidControlConfigError('control contains a symbol field');
  }
  const unknown = (keys as string[]).find(
    (key) => key !== 'mode' && key !== 'onUnavailable' && key !== 'timeoutMs',
  );
  if (unknown !== undefined) {
    throw new InvalidControlConfigError(`unknown field ${JSON.stringify(unknown)}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new InvalidControlConfigError('control fields must be enumerable data properties');
  }
  const mode = descriptors['mode']?.value ?? ControlMode.LEGACY;
  if (mode !== ControlMode.LEGACY && mode !== ControlMode.SHADOW && mode !== ControlMode.ENFORCE) {
    throw new InvalidControlConfigError('mode must be legacy, shadow, or enforce');
  }
  const onUnavailable = descriptors['onUnavailable']?.value ?? ControlUnavailablePolicy.ALLOW;
  if (
    onUnavailable !== ControlUnavailablePolicy.ALLOW &&
    onUnavailable !== ControlUnavailablePolicy.DENY
  ) {
    throw new InvalidControlConfigError('onUnavailable must be allow or deny');
  }
  const timeoutMs = descriptors['timeoutMs']?.value ?? DEFAULT_CONTROL_TIMEOUT_MS;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_CONTROL_TIMEOUT_MS ||
    timeoutMs > MAX_CONTROL_TIMEOUT_MS
  ) {
    throw new InvalidControlConfigError(
      `timeoutMs must be an integer between ${MIN_CONTROL_TIMEOUT_MS} and ${MAX_CONTROL_TIMEOUT_MS}`,
    );
  }
  return Object.freeze({ mode, onUnavailable, timeoutMs });
}

function consumeSnapshotBudget(budget: SnapshotBudget, amount = 1): void {
  budget.used += amount;
  if (budget.used > MAX_NON_LLM_SNAPSHOT_NODES) {
    throw new TypeError(
      `[pylva] nonLlm config cannot exceed ${MAX_NON_LLM_SNAPSHOT_NODES} nodes and properties`,
    );
  }
}

function snapshotConfigValue(
  value: unknown,
  budget: SnapshotBudget = { seen: new Set<object>(), used: 0 },
  depth = 0,
): unknown {
  consumeSnapshotBudget(budget);
  if (value === null || typeof value !== 'object') return value;
  if (isProxy(value) || depth > 32 || budget.seen.has(value)) {
    throw new TypeError('[pylva] nonLlm config must be a bounded acyclic plain value');
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('[pylva] nonLlm config arrays must use the built-in prototype');
    }
    const keys = Reflect.ownKeys(value);
    consumeSnapshotBudget(budget, keys.length);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)) ||
          (key !== 'length' && Number(key) >= value.length),
      )
    ) {
      throw new TypeError('[pylva] nonLlm config arrays cannot contain extra fields');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new TypeError('[pylva] nonLlm config arrays must be dense data arrays');
      }
      copy.push(snapshotConfigValue(descriptor.value, budget, depth + 1));
    }
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('[pylva] nonLlm config values must be plain objects');
  }
  const keys = Reflect.ownKeys(value);
  consumeSnapshotBudget(budget, keys.length);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('[pylva] nonLlm config cannot contain symbol fields');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new TypeError('[pylva] nonLlm config fields must be enumerable data properties');
    }
    Object.defineProperty(copy, key, {
      value: snapshotConfigValue(descriptor.value, budget, depth + 1),
      enumerable: true,
    });
  }
  return Object.freeze(copy);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`[pylva] ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(`[pylva] ${label} contains unknown field ${JSON.stringify(unknown)}`);
  }
}

function hasBoundedCodePointLength(value: string): boolean {
  let count = 0;
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    offset += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    count += 1;
    if (count > MAX_NON_LLM_TEXT_CODE_POINTS) return false;
  }
  return count > 0;
}

function validateRequiredText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !hasBoundedCodePointLength(value)) {
    throw new TypeError(
      `[pylva] ${label} must be a non-empty string of at most ${MAX_NON_LLM_TEXT_CODE_POINTS} code points`,
    );
  }
}

function validateOptionalText(value: unknown, label: string): void {
  if (value !== undefined && value !== null) {
    validateRequiredText(value, label);
  }
}

/** Snapshot and semantically validate standalone non-LLM configuration. */
export function snapshotNonLlmConfig(value: unknown): RuntimeConfig['nonLlm'] {
  if (value === undefined) return undefined;
  const snapshot = requireRecord(snapshotConfigValue(value), 'nonLlm config');
  rejectUnknownFields(snapshot, NON_LLM_KEYS, 'nonLlm config');

  const mode = snapshot['mode'];
  if (mode !== undefined && mode !== 'off' && mode !== 'policy' && mode !== 'legacy_all') {
    throw new TypeError('[pylva] nonLlm.mode must be off, policy, or legacy_all');
  }

  const refreshIntervalMs = snapshot['refreshIntervalMs'];
  if (
    refreshIntervalMs !== undefined &&
    (typeof refreshIntervalMs !== 'number' ||
      !Number.isFinite(refreshIntervalMs) ||
      refreshIntervalMs <= 0)
  ) {
    throw new TypeError('[pylva] nonLlm.refreshIntervalMs must be a positive finite number');
  }

  const policyValue = snapshot['policy'];
  if (policyValue !== undefined) {
    const policy = requireRecord(policyValue, 'nonLlm.policy');
    rejectUnknownFields(policy, NON_LLM_POLICY_KEYS, 'nonLlm.policy');
    const unknownBehavior = policy['unknown_behavior'];
    if (
      unknownBehavior !== undefined &&
      unknownBehavior !== 'discover_only' &&
      unknownBehavior !== 'ignore'
    ) {
      throw new TypeError('[pylva] nonLlm.policy.unknown_behavior must be discover_only or ignore');
    }
    const sourcesValue = policy['sources'];
    if (sourcesValue !== undefined) {
      if (!Array.isArray(sourcesValue)) {
        throw new TypeError('[pylva] nonLlm.policy.sources must be an array');
      }
      for (const [index, sourceValue] of sourcesValue.entries()) {
        const label = `nonLlm.policy.sources[${index}]`;
        const source = requireRecord(sourceValue, label);
        rejectUnknownFields(source, NON_LLM_SOURCE_KEYS, label);
        validateRequiredText(source['slug'], `${label}.slug`);
        if (source['status'] !== 'tracked' && source['status'] !== 'ignored') {
          throw new TypeError(`[pylva] ${label}.status must be tracked or ignored`);
        }
        const matchers = source['matchers'];
        if (
          !Array.isArray(matchers) ||
          matchers.some(
            (matcher) => typeof matcher !== 'string' || !hasBoundedCodePointLength(matcher),
          )
        ) {
          throw new TypeError(
            `[pylva] ${label}.matchers must be an array of non-empty strings of at most ${MAX_NON_LLM_TEXT_CODE_POINTS} code points`,
          );
        }
        validateOptionalText(source['metric'], `${label}.metric`);
        validateOptionalText(source['unit'], `${label}.unit`);
        const defaultMetricValue = source['default_metric_value'];
        if (
          defaultMetricValue !== undefined &&
          defaultMetricValue !== null &&
          (typeof defaultMetricValue !== 'number' ||
            !Number.isFinite(defaultMetricValue) ||
            defaultMetricValue < 0)
        ) {
          throw new TypeError(`[pylva] ${label}.default_metric_value must be non-negative or null`);
        }
      }
    }
  }

  const extractorsValue = snapshot['usageExtractors'];
  if (extractorsValue !== undefined) {
    const extractors = requireRecord(extractorsValue, 'nonLlm.usageExtractors');
    for (const [name, extractor] of Object.entries(extractors)) {
      validateRequiredText(name, 'nonLlm.usageExtractors key');
      if (typeof extractor !== 'function') {
        throw new TypeError(
          `[pylva] nonLlm.usageExtractors[${JSON.stringify(name)}] must be a function`,
        );
      }
    }
  }

  return snapshot as RuntimeConfig['nonLlm'];
}

function resolveConfig(value: unknown): ResolvedInstallConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidApiKeyError('init() requires a config object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new InvalidApiKeyError('config contains a symbol field');
  }
  const unknown = (keys as string[]).find((key) => !CONFIG_KEYS.has(key));
  if (unknown !== undefined) {
    throw new InvalidApiKeyError(`config contains unknown field ${JSON.stringify(unknown)}`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new InvalidApiKeyError('config fields must be enumerable data properties');
  }
  const apiKey = descriptors['apiKey']?.value;
  if (typeof apiKey !== 'string' || !API_KEY_PATTERN.test(apiKey)) {
    throw new InvalidApiKeyError('apiKey must match pv_(live|cli)_{8 hex}_{32 hex} format');
  }
  const batchSize = descriptors['batchSize']?.value ?? 100;
  const flushInterval = descriptors['flushInterval']?.value ?? 5_000;
  const localMode = descriptors['localMode']?.value ?? false;
  if (typeof batchSize !== 'number' || !Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new TypeError('[pylva] batchSize must be a positive integer');
  }
  if (
    typeof flushInterval !== 'number' ||
    !Number.isSafeInteger(flushInterval) ||
    flushInterval < 1
  ) {
    throw new TypeError('[pylva] flushInterval must be a positive integer');
  }
  if (typeof localMode !== 'boolean') {
    throw new TypeError('[pylva] localMode must be a boolean');
  }
  const config: RuntimeConfig = Object.freeze({
    endpoint: normalizeEndpoint(descriptors['endpoint']?.value),
    batchSize,
    flushInterval,
    localMode,
    ...(descriptors['nonLlm'] === undefined
      ? {}
      : { nonLlm: snapshotNonLlmConfig(descriptors['nonLlm'].value) }),
    control: resolveControlConfig(descriptors['control']?.value),
  });
  return Object.freeze({ apiKey, config });
}

export function init(config: InitConfig): RuntimeConfig {
  // Resolution is synchronous and complete before installResolved can abort
  // old requests, invoke resetters, or publish a replacement identity.
  const resolved = resolveConfig(config);
  installResolved(resolved);
  return resolved.config;
}

export function getConfig(): RuntimeConfig | null {
  return runtimeGetConfig();
}

export function requireConfig(): RuntimeConfig {
  return runtimeRequireConfig();
}

export function isInitialized(): boolean {
  return runtimeIsInitialized();
}

/** Internal builder-scoped cache generation; not part of the public facade. */
export function getConfigGeneration(): number {
  return runtimeGetConfigGeneration();
}

// Test-only: reset between tests. Not exported from the public index.
export function _resetConfigForTests(): void {
  _resetCoreRuntimeForTests();
}
