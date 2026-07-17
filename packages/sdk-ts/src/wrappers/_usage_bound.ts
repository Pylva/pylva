// Content-free, conservative input-token bounds for strict provider calls.
//
// Byte-level provider tokenizers cannot emit more tokens than the UTF-8 bytes
// needed to represent the request. We therefore count the complete JSON wire
// shape (including keys and punctuation) and add a fixed protocol allowance.
// Only the resulting integer is sent to Pylva; request content never leaves
// this process through the budget-control API.

import { PylvaStrictProviderError } from '../errors/strict_provider.js';
import { types as nodeTypes } from 'node:util';

export { PylvaStrictProviderError } from '../errors/strict_provider.js';

const textEncoder = new TextEncoder();
const PROTOCOL_ALLOWANCE_BYTES = 256;
const UINT32_MAX = 4_294_967_295;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;
const MAX_ARRAY_LENGTH = 100_000;
const MAX_OBJECT_KEYS = 10_000;
const MAX_STRING_CODE_UNITS = 1_000_000;
const NATIVE_ABORT_SIGNAL = AbortSignal;
const ABORT_SIGNAL_PROTOTYPE = NATIVE_ABORT_SIGNAL.prototype;
const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  ABORT_SIGNAL_PROTOTYPE,
  'aborted',
)?.get;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isProxyObject(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    nodeTypes.isProxy(value)
  );
}

function readExactAbortSignal(provider: 'openai' | 'anthropic', value: unknown): boolean {
  if (
    isProxyObject(value) ||
    !(value instanceof NATIVE_ABORT_SIGNAL) ||
    Object.getPrototypeOf(value) !== ABORT_SIGNAL_PROTOTYPE ||
    Object.getOwnPropertyNames(value).length !== 0 ||
    ABORT_SIGNAL_ABORTED_GETTER === undefined
  ) {
    throw new PylvaStrictProviderError(provider, 'request_options_are_invalid');
  }
  let aborted: unknown;
  try {
    aborted = Reflect.apply(ABORT_SIGNAL_ABORTED_GETTER, value, []);
  } catch {
    throw new PylvaStrictProviderError(provider, 'request_options_are_invalid');
  }
  if (typeof aborted !== 'boolean') {
    throw new PylvaStrictProviderError(provider, 'request_options_are_invalid');
  }
  return aborted;
}

/** Reject proxies, subclasses, own string shadows, and non-native signal brands. */
export function assertExactAbortSignal(
  provider: 'openai' | 'anthropic',
  value: unknown,
): asserts value is AbortSignal {
  readExactAbortSignal(provider, value);
}

/** Read `aborted` through the captured native getter after exact validation. */
export function abortSignalIsAborted(provider: 'openai' | 'anthropic', value: unknown): boolean {
  return readExactAbortSignal(provider, value);
}

export function assertJsonSerializationPosture(provider: 'openai' | 'anthropic'): void {
  if (
    Object.prototype.hasOwnProperty.call(Object.prototype, 'toJSON') ||
    Object.prototype.hasOwnProperty.call(Array.prototype, 'toJSON')
  ) {
    throw new PylvaStrictProviderError(provider, 'request_json_prototype_is_polluted');
  }
}

/** Read only own enumerable data descriptors; retain values without invoking getters. */
export function snapshotOwnDataProperties(
  provider: 'openai' | 'anthropic',
  value: unknown,
): Record<string, unknown> {
  if (isProxyObject(value) || !isPlainRecord(value)) {
    throw new PylvaStrictProviderError(provider, 'request_options_are_invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || keys.some((key) => typeof key === 'symbol')) {
    throw new PylvaStrictProviderError(provider, 'request_options_are_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    ) {
      throw new PylvaStrictProviderError(provider, 'request_options_are_invalid');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function encodedJsonStringBytes(value: string): number {
  // JSON.stringify is used only on one string/key at a time. It cannot follow
  // object references, and this value is never logged or retained.
  if (value.length > MAX_STRING_CODE_UNITS) {
    throw new RangeError('strict provider string exceeds local safety limit');
  }
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function addBound(total: number, amount: number): number {
  const next = total + amount;
  return next >= UINT32_MAX ? UINT32_MAX : next;
}

/**
 * Return a conservative upper bound for tokens in a JSON-compatible value.
 * Cycles, accessors, class instances, and non-JSON values are rejected before
 * reserve or provider dispatch so their serialization cannot diverge.
 */
export function estimateJsonUtf8TokenUpperBound(
  provider: 'openai' | 'anthropic',
  value: unknown,
): number {
  const seen = new Set<object>();
  const stack: Array<{ candidate: unknown; depth: number }> = [{ candidate: value, depth: 0 }];
  let nodes = 0;
  let total = PROTOCOL_ALLOWANCE_BYTES;

  while (stack.length > 0) {
    const { candidate, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
    }
    if (candidate === null) {
      total = addBound(total, 4);
      continue;
    }
    if (typeof candidate === 'string') {
      try {
        total = addBound(total, encodedJsonStringBytes(candidate));
      } catch {
        throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
      }
      continue;
    }
    if (typeof candidate === 'boolean') {
      total = addBound(total, candidate ? 4 : 5);
      continue;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new PylvaStrictProviderError(provider, 'request_contains_non_finite_number');
      }
      total = addBound(total, textEncoder.encode(JSON.stringify(candidate)).byteLength);
      continue;
    }
    if (typeof candidate !== 'object') {
      throw new PylvaStrictProviderError(provider, 'request_contains_non_json_value');
    }
    if (nodeTypes.isProxy(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_proxy');
    }
    if (seen.has(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_cycle_or_shared_reference');
    }
    seen.add(candidate);
    if (Reflect.ownKeys(candidate).some((key) => typeof key === 'symbol')) {
      throw new PylvaStrictProviderError(provider, 'request_contains_symbol_key');
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    total = addBound(total, 2);

    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        throw new PylvaStrictProviderError(provider, 'request_contains_non_plain_array');
      }
      const lengthDescriptor = descriptors['length'];
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
        throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
      }
      const keys = Object.keys(descriptors).filter((key) => key !== 'length');
      if (keys.length !== length) {
        throw new PylvaStrictProviderError(provider, 'request_contains_sparse_or_custom_array');
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        ) {
          throw new PylvaStrictProviderError(provider, 'request_contains_array_accessor');
        }
        if (index > 0) total = addBound(total, 1);
        stack.push({ candidate: descriptor.value, depth: depth + 1 });
      }
      continue;
    }

    if (!isPlainRecord(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_non_plain_object');
    }
    const keys = Object.keys(descriptors);
    if (keys.length > MAX_OBJECT_KEYS) {
      throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
    }
    let emitted = 0;
    for (const key of keys) {
      const descriptor = descriptors[key]!;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new PylvaStrictProviderError(provider, 'request_contains_accessor');
      }
      if (!descriptor.enumerable) {
        throw new PylvaStrictProviderError(provider, 'request_contains_non_enumerable_field');
      }
      if (emitted > 0) total = addBound(total, 1);
      try {
        total = addBound(total, encodedJsonStringBytes(key));
      } catch {
        throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
      }
      total = addBound(total, 1);
      stack.push({ candidate: descriptor.value, depth: depth + 1 });
      emitted += 1;
    }
  }

  return Math.max(1, total);
}

export interface DetachedJsonSnapshot {
  readonly value: unknown;
  readonly tokenUpperBound: number;
}

/**
 * Build the exact detached JSON value that may be priced and dispatched.
 *
 * Records are recreated with a null prototype and every value is read only
 * from an own data descriptor. This prevents inherited pollution, accessors,
 * proxies, and later caller mutation from changing semantic validation or the
 * provider wire body. The conservative byte/token bound is accumulated while
 * constructing this same snapshot.
 */
export function detachValidatedJson(
  provider: 'openai' | 'anthropic',
  value: unknown,
): DetachedJsonSnapshot {
  assertJsonSerializationPosture(provider);
  const seen = new Set<object>();
  let nodes = 0;
  let total = PROTOCOL_ALLOWANCE_BYTES;

  const clone = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
    }
    if (candidate === null) {
      total = addBound(total, 4);
      return null;
    }
    if (typeof candidate === 'string') {
      try {
        total = addBound(total, encodedJsonStringBytes(candidate));
      } catch {
        throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
      }
      return candidate;
    }
    if (typeof candidate === 'boolean') {
      total = addBound(total, candidate ? 4 : 5);
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new PylvaStrictProviderError(provider, 'request_contains_non_finite_number');
      }
      total = addBound(total, textEncoder.encode(JSON.stringify(candidate)).byteLength);
      return candidate;
    }
    if (typeof candidate !== 'object') {
      throw new PylvaStrictProviderError(provider, 'request_contains_non_json_value');
    }
    if (nodeTypes.isProxy(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_proxy');
    }
    if (seen.has(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_cycle_or_shared_reference');
    }
    seen.add(candidate);
    const ownKeys = Reflect.ownKeys(candidate);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new PylvaStrictProviderError(provider, 'request_contains_symbol_key');
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    total = addBound(total, 2);

    if (Array.isArray(candidate)) {
      if (Object.getPrototypeOf(candidate) !== Array.prototype) {
        throw new PylvaStrictProviderError(provider, 'request_contains_non_plain_array');
      }
      const length = descriptors['length']?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
        throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
      }
      const keys = ownKeys.filter((key): key is string => key !== 'length');
      if (keys.length !== length) {
        throw new PylvaStrictProviderError(provider, 'request_contains_sparse_or_custom_array');
      }
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        ) {
          throw new PylvaStrictProviderError(provider, 'request_contains_array_accessor');
        }
        if (index > 0) total = addBound(total, 1);
        Object.defineProperty(output, String(index), {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(output);
    }

    if (!isPlainRecord(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_non_plain_object');
    }
    const keys = ownKeys as string[];
    if (keys.length > MAX_OBJECT_KEYS) {
      throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      ) {
        throw new PylvaStrictProviderError(provider, 'request_contains_accessor');
      }
      if (index > 0) total = addBound(total, 1);
      try {
        total = addBound(total, encodedJsonStringBytes(key));
      } catch {
        throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
      }
      total = addBound(total, 1);
      Object.defineProperty(output, key, {
        value: clone(descriptor.value, depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(output);
  };

  const snapshot = clone(value, 0);
  return { value: snapshot, tokenUpperBound: Math.max(1, total) };
}

/** Reject a named key at every depth without reading or formatting its value. */
export function assertNoNestedKeys(
  provider: 'openai' | 'anthropic',
  value: unknown,
  forbidden: ReadonlySet<string>,
): void {
  const seen = new Set<object>();
  const stack: Array<{ candidate: unknown; depth: number }> = [{ candidate: value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { candidate, depth } = stack.pop()!;
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (nodeTypes.isProxy(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_proxy');
    }
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new PylvaStrictProviderError(provider, 'request_exceeds_local_complexity_limit');
    }
    if (seen.has(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_cycle_or_shared_reference');
    }
    seen.add(candidate);
    if (Reflect.ownKeys(candidate).some((key) => typeof key === 'symbol')) {
      throw new PylvaStrictProviderError(provider, 'request_contains_symbol_key');
    }
    if (!Array.isArray(candidate) && !isPlainRecord(candidate)) {
      throw new PylvaStrictProviderError(provider, 'request_contains_non_plain_object');
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(candidate) && key === 'length') continue;
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new PylvaStrictProviderError(provider, 'request_contains_accessor');
      }
      if (!descriptor.enumerable) {
        throw new PylvaStrictProviderError(provider, 'request_contains_non_enumerable_field');
      }
      if (forbidden.has(key)) {
        throw new PylvaStrictProviderError(provider, 'request_contains_unpriced_feature');
      }
      stack.push({ candidate: descriptor.value, depth: depth + 1 });
    }
  }
}
