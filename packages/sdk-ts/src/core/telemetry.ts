// Buffered telemetry exporter (D1, D6, D19, D32).
//
// - Bounded FIFO buffer (10K default). First overflow emits one console.warn;
//   subsequent overflows stay silent until the buffer drains below the cap.
// - LRU of sent span_ids (primary dedup; Redis on the server is a belt-and-
//   suspenders second layer — see §7.2).
// - HTTP exporter with 1 s / 2 s / 4 s retry schedule on transient errors.
// - 401 → loud one-time log + drop buffer + enter degraded state; init() never
//   does a network round-trip, so this is the only path that learns a key is bad.
// - errors[] from the ingest response → console.warn per rejected event + drop.
// - warnings[] from the ingest response → console.warn once per (provider, model)
//   or (metric) per process.

import { randomUUID } from 'node:crypto';
import type { IngestRequest, IngestResponse, TelemetryEvent } from '@pylva/shared/telemetry';
import { TokenCountSource } from '@pylva/shared/telemetry-values';
import type { BudgetExceededFlag } from '@pylva/shared/budget-errors';
import { getConfig } from './config.js';
import { markExceededFromBackend } from './budget_accumulator.js';
import { recordLlmSpend } from './budget_rules.js';
import { SDK_VERSION } from './version.js';
import { registerIdentityResetter } from './identity_registry.js';
import {
  AuthenticatedRoute,
  coreRuntime,
  type AuthenticatedResponseSnapshot,
} from '../internal/core-runtime-state.js';

const BUFFER_CAP = 10_000;
const LRU_CAP = 10_000;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

let buffer: TelemetryEvent[] = [];
let sentSpanIds: Set<string> = new Set();
let sentSpanIdsQueue: string[] = []; // FIFO order for LRU eviction
let flushTimer: ReturnType<typeof setInterval> | null = null;
let degraded = false;
let warnedOverflow = false;
let warnedEstimatedUsage = false;
let flushInFlight: Promise<void> | null = null;
const warnedUnknownModel = new Set<string>(); // keys: `${provider}|${model}` or `metric:${metric}`
let telemetryEpoch = 0;
const activeControllers = new Set<AbortController>();
const activeBatchCounts = new Map<number, number>();
const retryWaiters = new Set<{
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
}>();

function warnOnce(set: Set<string>, key: string, message: string): void {
  if (set.has(key)) return;
  set.add(key);

  console.warn(`[pylva] ${message}`);
}

function isBudgetExceededFlag(flag: unknown): flag is BudgetExceededFlag {
  if (flag === null || typeof flag !== 'object') return false;
  const candidate = flag as {
    rule_id?: unknown;
    customer_id?: unknown;
    limit_usd?: unknown;
    period_start?: unknown;
  };
  return (
    typeof candidate.rule_id === 'string' &&
    (typeof candidate.customer_id === 'string' || candidate.customer_id === null) &&
    typeof candidate.period_start === 'string' &&
    typeof candidate.limit_usd === 'number' &&
    Number.isFinite(candidate.limit_usd)
  );
}

const SCHEMA_VERSION = '1.6';
export function enqueue(event: Omit<TelemetryEvent, 'schema_version' | 'sdk_version'>): void {
  if (degraded) return;

  const full: TelemetryEvent = {
    ...event,
    schema_version: SCHEMA_VERSION,
    sdk_version: SDK_VERSION,
  } as TelemetryEvent;

  // Local budget accounting: bump every applicable budget rule's accumulator
  // with this call's cost so pre-call hard stops react in-process instead of
  // waiting for the backend flag / 5-min sync. Token-based like server-side
  // pricing; zero-token (failure) and non-LLM events no-op inside.
  recordLlmSpend({
    customer_id: full.customer_id ?? null,
    provider: full.provider ?? null,
    model: full.model ?? null,
    tokens_in: full.tokens_in ?? 0,
    tokens_out: full.tokens_out ?? 0,
  });

  // Track estimated-usage warning once per process.
  if (full.metadata?.token_count_source === TokenCountSource.ESTIMATED && !warnedEstimatedUsage) {
    warnedEstimatedUsage = true;

    console.warn(
      '[pylva] token counts estimated from stream chunks; upgrade `ai` to ≥3.3 for exact counts',
    );
  }

  if (buffer.length >= BUFFER_CAP) {
    if (!warnedOverflow) {
      warnedOverflow = true;

      console.warn(
        `[pylva] local buffer full (${BUFFER_CAP} events) — dropping oldest. Backend unreachable since start.`,
      );
    }
    buffer.shift();
  }
  buffer.push(full);

  const cfg = getConfig();
  if (cfg && buffer.length >= cfg.batchSize) {
    void flush();
  } else {
    ensureFlushTimer();
  }
}

function ensureFlushTimer(): void {
  if (flushTimer !== null) return;
  const cfg = getConfig();
  if (!cfg) return;
  flushTimer = setInterval(() => {
    void flush();
  }, cfg.flushInterval);
  // Don't keep the process alive for a flush timer.
  if (typeof (flushTimer as unknown as { unref?: () => void }).unref === 'function') {
    (flushTimer as unknown as { unref: () => void }).unref();
  }
}

function clearFlushTimer(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

export function bufferSize(): number {
  return buffer.length;
}

export function isDegraded(): boolean {
  return degraded;
}

export function flush(): Promise<void> {
  if (flushInFlight !== null) return flushInFlight;
  const promise = flushOnce();
  const wrapped = promise.finally(() => {
    if (flushInFlight === wrapped) flushInFlight = null;
  });
  flushInFlight = wrapped;
  return wrapped;
}

async function flushOnce(): Promise<void> {
  const owner = telemetryEpoch;
  if (degraded) return;
  const cfg = getConfig();
  if (!cfg) return;
  if (cfg.localMode) {
    buffer = [];
    return;
  }
  if (buffer.length === 0) return;

  const take = Math.min(buffer.length, cfg.batchSize);
  const batch = buffer.slice(0, take);
  buffer = buffer.slice(take);

  // SDK-side dedup: skip spans we already flushed once successfully.
  const newBatch = batch.filter((ev) => !sentSpanIds.has(ev.span_id));
  if (newBatch.length === 0) return;

  activeBatchCounts.set(owner, (activeBatchCounts.get(owner) ?? 0) + newBatch.length);
  try {
    await flushBatch(newBatch, owner);
  } finally {
    const remaining = (activeBatchCounts.get(owner) ?? 0) - newBatch.length;
    if (remaining > 0) activeBatchCounts.set(owner, remaining);
    else activeBatchCounts.delete(owner);
  }
}

async function flushBatch(newBatch: TelemetryEvent[], owner: number): Promise<void> {
  const body: IngestRequest = {
    batch_id: randomUUID(),
    sdk_version: SDK_VERSION,
    events: newBatch,
  };

  let response: AuthenticatedResponseSnapshot | null = null;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (owner !== telemetryEpoch) return;
    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      response = await coreRuntime.authenticatedRequest({
        route: AuthenticatedRoute.EVENTS,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (owner !== telemetryEpoch) return;
      if (response.status === 401) {
        enterDegraded(owner);
        return;
      }
      if (response.status >= 500) {
        // retry
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < RETRY_DELAYS_MS.length) {
          await delay(RETRY_DELAYS_MS[attempt]!);
          if (owner !== telemetryEpoch) return;
          continue;
        }
      }
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (owner !== telemetryEpoch) return;
      if (attempt < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[attempt]!);
        if (owner !== telemetryEpoch) return;
        continue;
      }
    } finally {
      activeControllers.delete(controller);
    }
  }

  if (owner !== telemetryEpoch) return;
  if (!response || response.status >= 500) {
    // Retries exhausted. Re-queue the batch at the head so the next flush retries.
    buffer = [...newBatch, ...buffer];
    if (buffer.length > BUFFER_CAP) {
      const drop = buffer.length - BUFFER_CAP;
      buffer = buffer.slice(drop);
    }

    console.warn(`[pylva] flush failed after retries: ${lastError?.message ?? 'unknown'}`);
    return;
  }

  if (!response.ok) {
    // 4xx non-auth — treat as permanent failure for this batch; drop it.

    console.warn(`[pylva] flush rejected: HTTP ${response.status}`);
    return;
  }

  let parsed: IngestResponse;
  try {
    parsed = JSON.parse(response.bodyText) as IngestResponse;
  } catch {
    // server success but unparseable — drop the batch and move on.
    return;
  }
  if (owner !== telemetryEpoch) return;

  // Mark accepted spans as sent so SDK doesn't re-send duplicates.
  for (const ev of newBatch) {
    recordSent(ev.span_id);
  }

  if (parsed.errors) {
    for (const e of parsed.errors) {
      const ev = newBatch[e.index];

      console.warn(`[pylva] event rejected: ${e.message} (span_id=${ev?.span_id ?? '?'})`);
    }
  }

  if (parsed.warnings) {
    for (const w of parsed.warnings) {
      if (w.code === 'needs_pricing_input' || w.code === 'pending_pricing') {
        const key = w.metric ? `metric:${w.metric}` : `llm:${w.provider ?? ''}:${w.model ?? ''}`;
        warnOnce(
          warnedUnknownModel,
          key,
          `pricing not yet configured for ${key} — cost will be backfilled once you add it in the dashboard`,
        );
      }
    }
  }

  if (Array.isArray(parsed.budget_exceeded)) {
    for (const flag of parsed.budget_exceeded as unknown[]) {
      if (!isBudgetExceededFlag(flag)) continue;
      markExceededFromBackend(flag);
    }
  }
}

function enterDegraded(owner: number): void {
  if (owner !== telemetryEpoch) return;
  degraded = true;
  buffer = [];
  clearFlushTimer();

  console.warn(
    '[pylva] API key was rejected. Check it at https://pylva.com/settings/keys. ' +
      'Telemetry is now disabled for this process.',
  );
}

function recordSent(spanId: string): void {
  if (sentSpanIds.has(spanId)) return;
  sentSpanIds.add(spanId);
  sentSpanIdsQueue.push(spanId);
  if (sentSpanIdsQueue.length > LRU_CAP) {
    const drop = sentSpanIdsQueue.length - LRU_CAP;
    const removed = sentSpanIdsQueue.splice(0, drop);
    for (const id of removed) sentSpanIds.delete(id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const waiter = {
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      resolve,
    };
    waiter.timer = setTimeout(() => {
      retryWaiters.delete(waiter);
      resolve();
    }, ms);
    retryWaiters.add(waiter);
    if (typeof (waiter.timer as unknown as { unref?: () => void }).unref === 'function') {
      (waiter.timer as unknown as { unref: () => void }).unref();
    }
  });
}

// Flush buffered events before process exit (best-effort).
if (typeof process !== 'undefined' && typeof process.on === 'function') {
  process.on('beforeExit', () => {
    if (buffer.length > 0 && !degraded) {
      void flush();
    }
  });
}

// Test-only resets.
export function _resetTelemetryForTests(): void {
  resetTelemetry(false);
}

function resetTelemetry(reportDropped: boolean): void {
  const owner = telemetryEpoch;
  const dropped = buffer.length + (activeBatchCounts.get(owner) ?? 0);
  telemetryEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  for (const waiter of retryWaiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
  retryWaiters.clear();
  activeBatchCounts.clear();
  flushInFlight = null;
  buffer = [];
  sentSpanIds = new Set();
  sentSpanIdsQueue = [];
  clearFlushTimer();
  degraded = false;
  warnedOverflow = false;
  warnedEstimatedUsage = false;
  warnedUnknownModel.clear();
  if (reportDropped && dropped > 0) {
    console.warn(`[pylva] SDK identity changed; dropped ${dropped} buffered telemetry events`);
  }
}

export function _resetTelemetryForIdentityChange(): void {
  resetTelemetry(true);
}

registerIdentityResetter(_resetTelemetryForIdentityChange);
