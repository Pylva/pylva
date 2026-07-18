import { randomUUID } from 'node:crypto';
import type { EventStatus, Framework } from '@pylva/shared/telemetry';
import { getConfig } from './config.js';
import { registerIdentityResetter } from './identity_registry.js';
import { AuthenticatedRoute, coreRuntime } from '../internal/core-runtime-state.js';

export type NonLlmMode = 'off' | 'policy' | 'legacy_all';

export interface NonLlmToolContext {
  toolName: string;
  matcher: string;
  customerId: string;
  stepName: string | null;
  status: EventStatus;
  framework: Framework;
  input?: unknown;
  output?: unknown;
  metadata: Record<string, unknown>;
}

export type NonLlmUsageExtractor = (ctx: NonLlmToolContext) => number | null | undefined;

export interface NonLlmPolicyOverrideSource {
  slug: string;
  status: 'tracked' | 'ignored';
  matchers: string[];
  metric?: string | null;
  unit?: string | null;
  default_metric_value?: number | null;
}

export interface NonLlmPolicyOverride {
  unknown_behavior?: 'discover_only' | 'ignore';
  sources?: NonLlmPolicyOverrideSource[];
}

export interface NonLlmConfig {
  mode?: NonLlmMode;
  policy?: NonLlmPolicyOverride;
  refreshIntervalMs?: number;
  usageExtractors?: Record<string, NonLlmUsageExtractor>;
}

export interface NormalizedPolicySource {
  slug: string;
  status: 'tracked' | 'ignored';
  matchers: string[];
  metric: string | null;
  unit: string | null;
  defaultMetricValue: number | null;
}

export type NonLlmDecision =
  | { kind: 'tracked'; source: NormalizedPolicySource; matcher: string }
  | { kind: 'ignored'; source: NormalizedPolicySource; matcher: string }
  | { kind: 'unknown'; matcher: string };

const DEFAULT_REFRESH_MS = 60_000;
const DISCOVERY_BUFFER_CAP = 1000;
const DISCOVERY_DEDUP_TTL_MS = 60_000;

let remotePolicy: NormalizedPolicySource[] = [];
let localPolicy: NormalizedPolicySource[] = [];
let unknownBehavior: 'discover_only' | 'ignore' = 'discover_only';
let fetchedAt = 0;
let refreshAfterMs = DEFAULT_REFRESH_MS;
let inFlight: Promise<void> | null = null;
let discoveryFlushTimer: ReturnType<typeof setTimeout> | null = null;
let discoveryBuffer: DiscoveryItem[] = [];
let discoveryDedup = new Map<string, number>();
let warnedPolicyFetch = false;
let warnedExtractor = new Set<string>();
let warnedLegacy = false;
let policyEpoch = 0;
const activeControllers = new Set<AbortController>();

interface DiscoveryItem {
  tool_name: string;
  matcher: string;
  step_name: string | null;
  framework: string;
  status: string;
  timestamp: string;
  count: number;
}

interface RemoteNonLlmPolicyResponse {
  refresh_after_ms?: unknown;
  unknown_behavior?: unknown;
  sources?: unknown;
}

export function normalizeNonLlmMatcher(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const sanitized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.:/-]+/g, '-');
  let start = 0;
  while (sanitized[start] === '-') start += 1;
  let end = sanitized.length;
  while (end > start && sanitized[end - 1] === '-') end -= 1;
  const normalized = sanitized.slice(start, end).slice(0, 100);
  return normalized.length > 0 ? normalized : null;
}

export function configureNonLlmPolicy(config: NonLlmConfig | undefined): void {
  localPolicy = normalizeOverride(config?.policy);
  unknownBehavior = config?.policy?.unknown_behavior ?? 'discover_only';
  refreshAfterMs = Math.max(10_000, config?.refreshIntervalMs ?? DEFAULT_REFRESH_MS);
}

export function nonLlmMode(config: NonLlmConfig | undefined, trackToolCalls?: boolean): NonLlmMode {
  if (config?.mode) return config.mode;
  return trackToolCalls ? 'legacy_all' : 'off';
}

export function warnLegacyToolTrackingOnce(): void {
  if (warnedLegacy) return;
  warnedLegacy = true;
  console.warn(
    '[pylva] trackToolCalls=true records every tool as non-LLM usage. Prefer nonLlm: { mode: "policy" } to track only approved sources.',
  );
}

export async function ensureNonLlmPolicy(): Promise<void> {
  const cfg = getConfig();
  if (!cfg || cfg.localMode) return;
  const now = Date.now();
  if (fetchedAt > 0 && now - fetchedAt < refreshAfterMs) return;
  if (inFlight) return inFlight;
  const owner = policyEpoch;
  const promise = refreshPolicy(now, owner);
  const wrapped = promise.finally(() => {
    if (inFlight === wrapped) inFlight = null;
  });
  inFlight = wrapped;
  return inFlight;
}

async function refreshPolicy(now: number, owner: number): Promise<void> {
  if (!getConfig()) return;
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    const res = await coreRuntime.authenticatedRequest({
      route: AuthenticatedRoute.NON_LLM_POLICY,
      signal: controller.signal,
    });
    if (owner !== policyEpoch) return;
    if (!res.ok) {
      warnPolicyFetchOnce();
      return;
    }
    const body = JSON.parse(res.bodyText) as unknown;
    if (owner !== policyEpoch) return;
    const normalized = normalizeRemotePolicy(body);
    if (!normalized) {
      warnPolicyFetchOnce();
      return;
    }
    remotePolicy = normalized.sources;
    unknownBehavior = normalized.unknownBehavior;
    refreshAfterMs = normalized.refreshAfterMs;
    fetchedAt = now;
    warnedPolicyFetch = false;
  } catch {
    if (owner !== policyEpoch) return;
    warnPolicyFetchOnce();
  } finally {
    activeControllers.delete(controller);
  }
}

function warnPolicyFetchOnce(): void {
  if (warnedPolicyFetch) return;
  warnedPolicyFetch = true;
  console.warn('[pylva] non-LLM policy fetch failed; keeping stale policy');
}

function normalizeRemotePolicy(body: unknown): {
  sources: NormalizedPolicySource[];
  unknownBehavior: 'discover_only' | 'ignore';
  refreshAfterMs: number;
} | null {
  if (body === null || typeof body !== 'object') return null;
  const candidate = body as RemoteNonLlmPolicyResponse;
  if (!Array.isArray(candidate.sources)) return null;
  return {
    sources: normalizeOverride({ sources: candidate.sources }),
    unknownBehavior: candidate.unknown_behavior === 'ignore' ? 'ignore' : 'discover_only',
    refreshAfterMs: Math.max(
      10_000,
      typeof candidate.refresh_after_ms === 'number' && Number.isFinite(candidate.refresh_after_ms)
        ? candidate.refresh_after_ms
        : DEFAULT_REFRESH_MS,
    ),
  };
}

function normalizeOverride(policy: NonLlmPolicyOverride | undefined): NormalizedPolicySource[] {
  const sources: NormalizedPolicySource[] = [];
  for (const source of policy?.sources ?? []) {
    if (
      !source ||
      typeof source.slug !== 'string' ||
      (source.status !== 'tracked' && source.status !== 'ignored') ||
      !Array.isArray(source.matchers)
    ) {
      continue;
    }
    const matchers = Array.from(
      new Set(source.matchers.map(normalizeNonLlmMatcher).filter((m): m is string => !!m)),
    );
    if (matchers.length === 0) continue;
    const defaultMetricValue =
      typeof source.default_metric_value === 'number' &&
      Number.isFinite(source.default_metric_value) &&
      source.default_metric_value >= 0
        ? source.default_metric_value
        : null;
    sources.push({
      slug: source.slug,
      status: source.status,
      matchers,
      metric: typeof source.metric === 'string' && source.metric.length > 0 ? source.metric : null,
      unit: typeof source.unit === 'string' && source.unit.length > 0 ? source.unit : null,
      defaultMetricValue,
    });
  }
  return sources;
}

export function decideNonLlmTool(candidates: string[]): NonLlmDecision {
  const normalized = candidates.map(normalizeNonLlmMatcher).filter((m): m is string => !!m);
  const matcher = normalized[0] ?? 'tool';
  const localIgnored = findMatch(localPolicy, normalized, 'ignored');
  if (localIgnored)
    return { kind: 'ignored', source: localIgnored.source, matcher: localIgnored.matcher };
  const localTracked = findMatch(localPolicy, normalized, 'tracked');
  if (localTracked)
    return { kind: 'tracked', source: localTracked.source, matcher: localTracked.matcher };
  const remoteIgnored = findMatch(remotePolicy, normalized, 'ignored');
  if (remoteIgnored)
    return { kind: 'ignored', source: remoteIgnored.source, matcher: remoteIgnored.matcher };
  const remoteTracked = findMatch(remotePolicy, normalized, 'tracked');
  if (remoteTracked)
    return { kind: 'tracked', source: remoteTracked.source, matcher: remoteTracked.matcher };
  return { kind: 'unknown', matcher };
}

function findMatch(
  sources: NormalizedPolicySource[],
  candidates: string[],
  status: 'tracked' | 'ignored',
): { source: NormalizedPolicySource; matcher: string } | null {
  for (const candidate of candidates) {
    for (const source of sources) {
      if (source.status !== status) continue;
      if (source.matchers.includes(candidate)) return { source, matcher: candidate };
    }
  }
  return null;
}

export function metricValueForSource(
  source: NormalizedPolicySource,
  ctx: NonLlmToolContext,
  extractors: Record<string, NonLlmUsageExtractor> | undefined,
): number | null {
  const extractor = extractors?.[source.slug] ?? extractors?.[ctx.matcher] ?? undefined;
  if (extractor) {
    try {
      const value = extractor(ctx);
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    } catch {
      /* warn below */
    }
    warnExtractorOnce(source.slug);
    return null;
  }
  if (source.defaultMetricValue !== null) return source.defaultMetricValue;
  warnExtractorOnce(source.slug);
  return null;
}

function warnExtractorOnce(slug: string): void {
  if (warnedExtractor.has(slug)) return;
  warnedExtractor.add(slug);
  console.warn(`[pylva] non-LLM source ${slug} has no valid usage value; event skipped`);
}

export function recordNonLlmDiscovery(input: {
  toolName: string;
  matcher: string;
  stepName: string | null;
  framework: Framework;
  status: EventStatus;
}): void {
  if (unknownBehavior === 'ignore') return;
  const cfg = getConfig();
  if (!cfg || cfg.localMode) return;
  const now = Date.now();
  const dedupKey = input.matcher;
  const last = discoveryDedup.get(dedupKey);
  if (last !== undefined && now - last < DISCOVERY_DEDUP_TTL_MS) return;
  discoveryDedup.set(dedupKey, now);
  discoveryBuffer.push({
    tool_name: input.toolName.slice(0, 200),
    matcher: input.matcher,
    step_name: input.stepName,
    framework: input.framework,
    status: input.status,
    timestamp: new Date().toISOString(),
    count: 1,
  });
  if (discoveryBuffer.length > DISCOVERY_BUFFER_CAP) {
    discoveryBuffer = discoveryBuffer.slice(discoveryBuffer.length - DISCOVERY_BUFFER_CAP);
  }
  scheduleDiscoveryFlush();
}

function scheduleDiscoveryFlush(): void {
  if (discoveryFlushTimer) return;
  discoveryFlushTimer = setTimeout(() => {
    discoveryFlushTimer = null;
    void flushNonLlmDiscoveries();
  }, 250);
  discoveryFlushTimer.unref?.();
}

export async function flushNonLlmDiscoveries(): Promise<void> {
  const cfg = getConfig();
  if (!cfg || cfg.localMode || discoveryBuffer.length === 0) return;
  const batch = discoveryBuffer.slice(0, 100);
  discoveryBuffer = discoveryBuffer.slice(batch.length);
  const owner = policyEpoch;
  const controller = new AbortController();
  activeControllers.add(controller);
  try {
    await coreRuntime.authenticatedRequest({
      route: AuthenticatedRoute.NON_LLM_DISCOVERIES,
      body: JSON.stringify({ batch_id: randomUUID(), discoveries: batch }),
      signal: controller.signal,
    });
  } catch {
    // R1: discovery is advisory and must never affect host code.
  } finally {
    activeControllers.delete(controller);
  }
  if (owner !== policyEpoch) return;
  if (discoveryBuffer.length > 0) scheduleDiscoveryFlush();
}

export function _resetNonLlmPolicyForTests(): void {
  resetNonLlmPolicy();
}

function resetNonLlmPolicy(): void {
  policyEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  remotePolicy = [];
  localPolicy = [];
  unknownBehavior = 'discover_only';
  fetchedAt = 0;
  refreshAfterMs = DEFAULT_REFRESH_MS;
  inFlight = null;
  if (discoveryFlushTimer) clearTimeout(discoveryFlushTimer);
  discoveryFlushTimer = null;
  discoveryBuffer = [];
  discoveryDedup = new Map();
  warnedPolicyFetch = false;
  warnedExtractor.clear();
  warnedLegacy = false;
}

export function _resetNonLlmPolicyForIdentityChange(): void {
  resetNonLlmPolicy();
}

registerIdentityResetter(_resetNonLlmPolicyForIdentityChange);
