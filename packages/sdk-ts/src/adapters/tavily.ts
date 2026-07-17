// Authoritative one-credit Tavily Search adapter.
//
// This adapter intentionally accepts only basic search with automatic
// parameters disabled. Advanced/automatic search must use controlledUsage
// with an explicit two-credit maximum and provider usage extractor.

import { isProxy } from 'node:util/types';
import { controlledUsage, type ControlledUsageResult } from '../core/controlled_usage.js';
import { linkLocalControlledCallbackNoDispatch } from '../core/control_correlation.js';
import { PylvaControlValidationError } from '../errors/control.js';

export const TAVILY_SEARCH_COST_SOURCE_SLUG = 'tavily-search' as const;
export const TAVILY_SEARCH_TOOL_NAME = 'Tavily Search' as const;
export const TAVILY_SEARCH_METRIC = 'credit' as const;
export const TAVILY_BASIC_SEARCH_CREDITS = '1' as const;

export interface TavilySearchClient<T> {
  search(query: string, options?: Readonly<Record<string, unknown>>): Promise<T>;
}

export interface ControlledTavilySearchInput {
  query: string;
  customerId?: string;
  step?: string;
  searchDepth?: 'basic' | 'advanced' | 'fast' | 'ultra-fast';
  autoParameters?: boolean;
  searchOptions?: Readonly<Record<string, unknown>>;
  reservationTtlSeconds?: number;
  heartbeatIntervalMs?: number;
}

const INPUT_KEYS = new Set([
  'query',
  'customerId',
  'step',
  'searchDepth',
  'autoParameters',
  'searchOptions',
  'reservationTtlSeconds',
  'heartbeatIntervalMs',
]);
const MAX_OPTION_DEPTH = 8;
const MAX_OPTION_NODES = 1_024;
const MAX_OPTION_KEYS = 128;
const MAX_OPTION_KEY_LENGTH = 128;
const MAX_OPTION_ARRAY_LENGTH = 256;
const MAX_OPTION_STRING_LENGTH = 16_384;

function validationError(): PylvaControlValidationError {
  linkLocalControlledCallbackNoDispatch('tool');
  return new PylvaControlValidationError('controlledTavilySearch');
}

function defineData(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function strictInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw validationError();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError();
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || !INPUT_KEYS.has(key)) {
      throw validationError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw validationError();
    }
    defineData(snapshot, key, descriptor.value);
  }
  return snapshot;
}

interface SnapshotState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

function snapshotPlainJson(value: unknown, state: SnapshotState, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_OPTION_NODES || depth > MAX_OPTION_DEPTH) throw validationError();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_OPTION_STRING_LENGTH) throw validationError();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw validationError();
    return value;
  }
  if (typeof value !== 'object' || isProxy(value)) throw validationError();
  if (state.seen.has(value)) throw validationError();
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_OPTION_ARRAY_LENGTH
    ) {
      throw validationError();
    }
    let indexedKeys = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
        throw validationError();
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= value.length || String(index) !== key) {
        throw validationError();
      }
      indexedKeys += 1;
    }
    if (indexedKeys !== value.length) throw validationError();
    const snapshot: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw validationError();
      }
      snapshot.push(snapshotPlainJson(descriptor.value, state, depth + 1));
    }
    return snapshot;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw validationError();
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_OPTION_KEYS) throw validationError();
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string' || key === '__proto__' || key.length > MAX_OPTION_KEY_LENGTH) {
      throw validationError();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw validationError();
    }
    defineData(snapshot, key, snapshotPlainJson(descriptor.value, state, depth + 1));
  }
  return snapshot;
}

function searchOptions(
  raw: unknown,
  searchDepthInput: unknown,
  autoParametersInput: unknown,
): Readonly<Record<string, unknown>> {
  const searchDepth = searchDepthInput === undefined ? 'basic' : searchDepthInput;
  const autoParameters = autoParametersInput === undefined ? false : autoParametersInput;
  if (searchDepth !== 'basic' || autoParameters !== false) {
    throw validationError();
  }
  const options = snapshotPlainJson(raw === undefined ? {} : raw, {
    seen: new WeakSet(),
    nodes: 0,
  });
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw validationError();
  }
  const optionRecord = options as Record<string, unknown>;
  // @tavily/core forwards unknown snake_case keys after its mapped fields, so
  // aliases of locked fields must be rejected instead of merely overwritten.
  if (
    Object.hasOwn(optionRecord, 'query') ||
    Object.hasOwn(optionRecord, 'search_depth') ||
    Object.hasOwn(optionRecord, 'auto_parameters') ||
    Object.hasOwn(optionRecord, 'include_usage') ||
    (optionRecord['searchDepth'] ?? 'basic') !== 'basic' ||
    (optionRecord['autoParameters'] ?? false) !== false
  ) {
    throw validationError();
  }
  // Caller values cannot weaken the exact one-credit contract.
  defineData(optionRecord, 'searchDepth', 'basic');
  defineData(optionRecord, 'autoParameters', false);
  defineData(optionRecord, 'includeUsage', true);
  return optionRecord;
}

function boundSearch<T>(client: TavilySearchClient<T>): TavilySearchClient<T>['search'] {
  if (typeof client !== 'object' || client === null || isProxy(client)) throw validationError();
  let search: unknown;
  let owner: object | null = client;
  let traversed = 0;
  while (owner !== null && traversed <= 16) {
    if (isProxy(owner)) throw validationError();
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'search');
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) throw validationError();
      search = descriptor.value;
      break;
    }
    owner = Object.getPrototypeOf(owner) as object | null;
    traversed += 1;
  }
  if (typeof search !== 'function' || isProxy(search)) throw validationError();
  return (query, options) => Reflect.apply(search, client, [query, options]) as Promise<T>;
}

function credits(response: unknown): string {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    throw new TypeError('missing Tavily usage');
  }
  const usage = (response as Record<string, unknown>)['usage'];
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    throw new TypeError('missing Tavily usage');
  }
  const value = (usage as Record<string, unknown>)['credits'];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const normalized = value.replace(/^0+(?=\d)/, '');
    if (normalized !== '0') return normalized;
  }
  throw new TypeError('missing Tavily usage');
}

/** Call `@tavily/core` search under an exact one-credit reservation. */
export async function controlledTavilySearch<T>(
  client: TavilySearchClient<T>,
  rawInput: ControlledTavilySearchInput,
): Promise<ControlledUsageResult<T>> {
  const input = strictInput(rawInput);
  // Snapshot the complete adapter input before any user-controlled transport
  // lookup and before controlledUsage can await its reservation.
  const query = input['query'];
  const customerId = input['customerId'];
  const step = input['step'];
  const reservationTtlSeconds = input['reservationTtlSeconds'];
  const heartbeatIntervalMs = input['heartbeatIntervalMs'];
  const options = searchOptions(
    input['searchOptions'],
    input['searchDepth'],
    input['autoParameters'],
  );
  if (typeof query !== 'string' || query.length === 0) {
    throw validationError();
  }
  const search = boundSearch(client);
  return controlledUsage({
    costSourceSlug: TAVILY_SEARCH_COST_SOURCE_SLUG,
    toolName: TAVILY_SEARCH_TOOL_NAME,
    metric: TAVILY_SEARCH_METRIC,
    maximumValue: TAVILY_BASIC_SEARCH_CREDITS,
    invoke: () => search(query, options),
    extractActual: credits,
    customerId: customerId as string | undefined,
    step: step as string | undefined,
    reservationTtlSeconds: reservationTtlSeconds as number | undefined,
    heartbeatIntervalMs: heartbeatIntervalMs as number | undefined,
  });
}
