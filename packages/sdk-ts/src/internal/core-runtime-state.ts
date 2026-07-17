import { SDK_VERSION } from '../core/version.js';
import type { NonLlmConfig } from '../core/non_llm_policy.js';
import { isProxy } from 'node:util/types';

export const ControlMode = {
  LEGACY: 'legacy',
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
} as const;
export type ControlMode = (typeof ControlMode)[keyof typeof ControlMode];

export const ControlUnavailablePolicy = {
  ALLOW: 'allow',
  DENY: 'deny',
} as const;
export type ControlUnavailablePolicy =
  (typeof ControlUnavailablePolicy)[keyof typeof ControlUnavailablePolicy];

export const DEFAULT_CONTROL_TIMEOUT_MS = 2_000;
export const MIN_CONTROL_TIMEOUT_MS = 100;
export const MAX_CONTROL_TIMEOUT_MS = 30_000;

// These constructors live in the canonical runtime so every independently
// built public entrypoint throws the same catch-path identity. Raw validation
// remains in core/config.ts and is not pulled into provider closures.
export class InvalidApiKeyError extends Error {
  constructor(message = 'Invalid Pylva API key format') {
    super(`[pylva] ${message}`);
    this.name = 'InvalidApiKeyError';
  }
}
Object.defineProperty(InvalidApiKeyError, 'name', { value: 'InvalidApiKeyError' });

export class InvalidControlConfigError extends TypeError {
  constructor(message: string) {
    super(`[pylva] invalid control config: ${message}`);
    this.name = 'InvalidControlConfigError';
  }
}
Object.defineProperty(InvalidControlConfigError, 'name', { value: 'InvalidControlConfigError' });

export interface ControlConfig {
  mode?: ControlMode;
  onUnavailable?: ControlUnavailablePolicy;
  timeoutMs?: number;
}

export interface ResolvedControlConfig {
  readonly mode: ControlMode;
  readonly onUnavailable: ControlUnavailablePolicy;
  readonly timeoutMs: number;
}

export interface InitConfig {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number;
  localMode?: boolean;
  nonLlm?: NonLlmConfig;
  control?: ControlConfig;
}

/**
 * Public v1.1 resolved-configuration shape. This declaration remains source
 * compatible for existing consumers; runtime code uses RuntimeConfig below so
 * credentials never cross the canonical state boundary.
 */
export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  batchSize: number;
  flushInterval: number;
  localMode: boolean;
  nonLlm?: NonLlmConfig;
  control?: ResolvedControlConfig;
}

/** Safe internal SDK configuration view. The credential never crosses this boundary. */
export interface RuntimeConfig {
  readonly endpoint: string;
  readonly batchSize: number;
  readonly flushInterval: number;
  readonly localMode: boolean;
  readonly nonLlm?: NonLlmConfig;
  readonly control: ResolvedControlConfig;
}

/** @internal Fully validated, detached credential-bearing install value. */
export interface ResolvedInstallConfig {
  readonly apiKey: string;
  readonly config: RuntimeConfig;
}

export const AuthenticatedRoute = {
  PRICING: 'pricing',
  RULES: 'rules',
  NON_LLM_POLICY: 'non_llm_policy',
  NON_LLM_DISCOVERIES: 'non_llm_discoveries',
  EVENTS: 'events',
  BUDGET_SYNC: 'budget_sync',
  CONTROL_CAPABILITIES: 'control_capabilities',
  CONTROL_RESERVE: 'control_reserve',
  CONTROL_COMMIT: 'control_commit',
  CONTROL_RELEASE: 'control_release',
  CONTROL_EXTEND: 'control_extend',
} as const;
export type AuthenticatedRoute = (typeof AuthenticatedRoute)[keyof typeof AuthenticatedRoute];

type GetRoute =
  | typeof AuthenticatedRoute.PRICING
  | typeof AuthenticatedRoute.RULES
  | typeof AuthenticatedRoute.NON_LLM_POLICY
  | typeof AuthenticatedRoute.CONTROL_CAPABILITIES;
type PostRoute =
  | typeof AuthenticatedRoute.NON_LLM_DISCOVERIES
  | typeof AuthenticatedRoute.EVENTS
  | typeof AuthenticatedRoute.BUDGET_SYNC
  | typeof AuthenticatedRoute.CONTROL_RESERVE;
type LifecycleRoute =
  | typeof AuthenticatedRoute.CONTROL_COMMIT
  | typeof AuthenticatedRoute.CONTROL_RELEASE
  | typeof AuthenticatedRoute.CONTROL_EXTEND;

export type AuthenticatedRequest =
  | { readonly route: GetRoute; readonly signal?: AbortSignal }
  | { readonly route: PostRoute; readonly body: string; readonly signal?: AbortSignal }
  | {
      readonly route: LifecycleRoute;
      readonly reservationId: string;
      readonly body: string;
      readonly signal?: AbortSignal;
    };

export interface CoreRuntimeCoordinator {
  readonly getConfig: () => RuntimeConfig | null;
  readonly requireConfig: () => RuntimeConfig;
  readonly isInitialized: () => boolean;
  readonly generation: () => number;
  readonly registerIdentityResetter: (resetter: () => void) => void;
  readonly authenticatedRequest: (
    request: AuthenticatedRequest,
  ) => Promise<AuthenticatedResponseSnapshot>;
}

/** A fully consumed, immutable response. No live provider-owned body escapes. */
export interface AuthenticatedResponseSnapshot {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
}

const RESERVATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;
const CATALOG_RESPONSE_BYTES = 8 * 1024 * 1024;

interface RuntimeState {
  current: ResolvedInstallConfig | null;
  safeCurrent: RuntimeConfig | null;
  generation: number;
  resetters: Set<() => void>;
  activeControllers: Set<AbortController>;
}

function snapshotAuthenticatedRequest(value: unknown): AuthenticatedRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError('[pylva] authenticated request must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) {
    throw new TypeError('[pylva] authenticated request cannot contain symbol fields');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) =>
        !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined,
    )
  ) {
    throw new TypeError('[pylva] authenticated request fields must be enumerable data properties');
  }
  const route = descriptors['route']?.value as unknown;
  let required: readonly string[];
  switch (route) {
    case AuthenticatedRoute.PRICING:
    case AuthenticatedRoute.RULES:
    case AuthenticatedRoute.NON_LLM_POLICY:
    case AuthenticatedRoute.CONTROL_CAPABILITIES:
      required = ['route'];
      break;
    case AuthenticatedRoute.NON_LLM_DISCOVERIES:
    case AuthenticatedRoute.EVENTS:
    case AuthenticatedRoute.BUDGET_SYNC:
    case AuthenticatedRoute.CONTROL_RESERVE:
      required = ['route', 'body'];
      break;
    case AuthenticatedRoute.CONTROL_COMMIT:
    case AuthenticatedRoute.CONTROL_RELEASE:
    case AuthenticatedRoute.CONTROL_EXTEND:
      required = ['route', 'reservationId', 'body'];
      break;
    default:
      throw new TypeError('[pylva] authenticated request route is not supported');
  }
  const allowed = new Set([...required, 'signal']);
  const unknown = (keys as string[]).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new TypeError(
      `[pylva] authenticated request contains unknown field ${JSON.stringify(unknown)}`,
    );
  }
  const missing = required.find((key) => descriptors[key] === undefined);
  if (missing !== undefined) {
    throw new TypeError(
      `[pylva] authenticated request is missing field ${JSON.stringify(missing)}`,
    );
  }
  const signal = descriptors['signal']?.value as unknown;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('[pylva] authenticated request signal must be an AbortSignal');
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    if (descriptors[key] !== undefined) {
      Object.defineProperty(snapshot, key, { value: descriptors[key].value, enumerable: true });
    }
  }
  return Object.freeze(snapshot) as unknown as AuthenticatedRequest;
}

function routePath(request: AuthenticatedRequest): {
  path: string;
  method: 'GET' | 'POST';
  control: boolean;
  maxResponseBytes: number;
  body?: string;
} {
  switch (request.route) {
    case AuthenticatedRoute.PRICING:
      return {
        path: '/api/v1/pricing',
        method: 'GET',
        control: false,
        maxResponseBytes: CATALOG_RESPONSE_BYTES,
      };
    case AuthenticatedRoute.RULES:
      return {
        path: '/api/v1/rules',
        method: 'GET',
        control: false,
        maxResponseBytes: CATALOG_RESPONSE_BYTES,
      };
    case AuthenticatedRoute.NON_LLM_POLICY:
      return {
        path: '/api/v1/sdk/non-llm-policy',
        method: 'GET',
        control: false,
        maxResponseBytes: CATALOG_RESPONSE_BYTES,
      };
    case AuthenticatedRoute.NON_LLM_DISCOVERIES:
      return post('/api/v1/sdk/non-llm-discoveries', request.body, false);
    case AuthenticatedRoute.EVENTS:
      return post('/api/v1/events', request.body, false);
    case AuthenticatedRoute.BUDGET_SYNC:
      return post('/api/v1/budget/sync', request.body, false);
    case AuthenticatedRoute.CONTROL_CAPABILITIES:
      return {
        path: '/api/v1/budget/capabilities',
        method: 'GET',
        control: true,
        maxResponseBytes: DEFAULT_RESPONSE_BYTES,
      };
    case AuthenticatedRoute.CONTROL_RESERVE:
      return post('/api/v1/budget/reservations', request.body, true);
    case AuthenticatedRoute.CONTROL_COMMIT:
    case AuthenticatedRoute.CONTROL_RELEASE:
    case AuthenticatedRoute.CONTROL_EXTEND: {
      if (!RESERVATION_ID_PATTERN.test(request.reservationId)) {
        throw new TypeError('[pylva] reservationId must be a UUID');
      }
      const suffix = request.route.slice('control_'.length);
      return post(
        `/api/v1/budget/reservations/${encodeURIComponent(request.reservationId)}/${suffix}`,
        request.body,
        true,
      );
    }
    default:
      throw new TypeError('[pylva] authenticated request route is not supported');
  }
}

function post(path: string, body: unknown, control: boolean) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new TypeError('[pylva] authenticated request body must be bounded serialized JSON');
  }
  return {
    path,
    method: 'POST' as const,
    control,
    body,
    maxResponseBytes: DEFAULT_RESPONSE_BYTES,
  };
}

function joinEndpoint(endpoint: string, path: string): string {
  return `${endpoint}${path}`;
}

async function consumeBoundedResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<AuthenticatedResponseSnapshot> {
  const reader = response.body?.getReader();
  let bodyText = '';
  if (reader !== undefined) {
    const decoder = new TextDecoder();
    let bytes = 0;
    const cancel = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel(new TypeError('[pylva] authenticated response body exceeds limit'));
          throw new TypeError('[pylva] authenticated response body exceeds limit');
        }
        bodyText += decoder.decode(value, { stream: true });
      }
      bodyText += decoder.decode();
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(snapshot, {
    ok: { value: response.ok, enumerable: true },
    status: { value: response.status, enumerable: true },
    statusText: { value: response.statusText, enumerable: true },
    bodyText: { value: bodyText, enumerable: true },
  });
  return Object.freeze(snapshot) as unknown as AuthenticatedResponseSnapshot;
}

function createCoordinator(): {
  coordinator: CoreRuntimeCoordinator;
  installResolved: (config: ResolvedInstallConfig) => void;
  resetForTests: (options?: { clearResetters?: boolean }) => void;
} {
  const state: RuntimeState = {
    current: null,
    safeCurrent: null,
    generation: 0,
    resetters: new Set(),
    activeControllers: new Set(),
  };

  const abortActiveRequests = (): void => {
    for (const controller of state.activeControllers) controller.abort();
    state.activeControllers.clear();
  };

  const resetIdentity = (): void => {
    abortActiveRequests();
    const failures: unknown[] = [];
    for (const resetter of state.resetters) {
      try {
        const result: unknown = resetter();
        if (result && typeof (result as unknown as { then?: unknown }).then === 'function') {
          failures.push(new TypeError('identity resetters must be synchronous'));
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, '[pylva] SDK identity reset failed');
    }
  };

  const installResolved = Object.freeze((next: ResolvedInstallConfig): void => {
    const changed =
      state.current !== null &&
      (state.current.apiKey !== next.apiKey ||
        state.current.config.endpoint !== next.config.endpoint);
    if (changed) resetIdentity();
    if (state.current === null || changed) state.generation += 1;
    state.current = next;
    state.safeCurrent = next.config;
  });

  const getConfig = Object.freeze((): RuntimeConfig | null => state.safeCurrent);
  const requireConfig = Object.freeze((): RuntimeConfig => {
    if (state.safeCurrent === null) {
      throw new Error('[pylva] SDK not initialized; call pylva.init({ apiKey }) first');
    }
    return state.safeCurrent;
  });
  const isInitialized = Object.freeze((): boolean => state.current !== null);
  const generation = Object.freeze((): number => state.generation);
  const registerIdentityResetter = Object.freeze((resetter: () => void): void => {
    if (typeof resetter !== 'function') {
      throw new TypeError('[pylva] identity resetter must be a synchronous function');
    }
    state.resetters.add(resetter);
  });
  const authenticatedRequest = Object.freeze(
    async (request: AuthenticatedRequest): Promise<AuthenticatedResponseSnapshot> => {
      const config = state.current;
      if (config === null) {
        throw new Error('[pylva] SDK not initialized; call pylva.init({ apiKey }) first');
      }
      const requestSnapshot = snapshotAuthenticatedRequest(request);
      const route = routePath(requestSnapshot);
      const callerSignal = requestSnapshot.signal;
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(callerSignal?.reason);
      if (callerSignal?.aborted) forwardAbort();
      else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
      state.activeControllers.add(controller);
      const headers: Record<string, string> = { 'X-Pylva-Key': config.apiKey };
      if (route.method === 'POST') headers['Content-Type'] = 'application/json';
      if (route.control) {
        headers['Accept'] = 'application/json';
        headers['X-Pylva-SDK-Version'] = SDK_VERSION;
        headers['X-Pylva-SDK-Language'] = 'typescript';
      }
      try {
        const response = await fetch(joinEndpoint(config.config.endpoint, route.path), {
          method: route.method,
          headers,
          ...(route.body === undefined ? {} : { body: route.body }),
          signal: controller.signal,
          ...(route.control ? { cache: 'no-store' as const } : {}),
        });
        return await consumeBoundedResponse(response, controller.signal, route.maxResponseBytes);
      } finally {
        callerSignal?.removeEventListener('abort', forwardAbort);
        state.activeControllers.delete(controller);
      }
    },
  );

  const coordinator = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(coordinator, {
    getConfig: { value: getConfig, enumerable: true },
    requireConfig: { value: requireConfig, enumerable: true },
    isInitialized: { value: isInitialized, enumerable: true },
    generation: { value: generation, enumerable: true },
    registerIdentityResetter: { value: registerIdentityResetter, enumerable: true },
    authenticatedRequest: { value: authenticatedRequest, enumerable: true },
  });

  const resetForTests = (options?: { clearResetters?: boolean }): void => {
    abortActiveRequests();
    state.current = null;
    state.safeCurrent = null;
    state.generation += 1;
    if (options?.clearResetters) state.resetters.clear();
  };
  return {
    coordinator: Object.freeze(coordinator) as unknown as CoreRuntimeCoordinator,
    installResolved,
    resetForTests,
  };
}

const created = createCoordinator();
// Final package builds route every public entrypoint through one physical
// CommonJS artifact. The module cache, rather than a mutable/discoverable
// global rendezvous, is therefore the sole authority for this closure.
export const coreRuntime = created.coordinator;
/** @internal Raw public configuration must never cross this boundary. */
export const installResolved = created.installResolved;
export const getConfig = coreRuntime.getConfig;
export const requireConfig = coreRuntime.requireConfig;
export const isInitialized = coreRuntime.isInitialized;
export const getConfigGeneration = coreRuntime.generation;

export function _resetCoreRuntimeForTests(options?: { clearResetters?: boolean }): void {
  created.resetForTests(options);
}
