// B2a — SDK-side budget accumulator (D3 / §6).
//
// Per-SDK-process Map keyed on `${rule_id}:${scope_token}:${period_start}`
// where scope_token = scope === 'pooled' ? '__pooled__' : customer_id.
// This is a *near-real-time* signal on long-lived ECS tasks; cross-container
// drift is bounded by the ingest round-trip × concurrent SDK instances. The
// backend ingest-response `budget_exceeded[]` flag is the authoritative stop
// (I-T3-2).
//
// Eviction: LRU at 50,000 entries. Overflow is logged once per 5-min window.
// Sync: onInit POSTs current state to /api/v1/budget/sync to prime; a loop
// every SYNC_INTERVAL_MS re-reconciles. server_total REPLACES local (I-T3-3).

import { getConfig } from './config.js';
import type { BudgetExceededFlag } from '@pylva/shared/budget-errors';
import { registerIdentityResetter } from './identity_registry.js';
import { AuthenticatedRoute, coreRuntime } from '../internal/core-runtime-state.js';

const LRU_MAX = 50_000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
// The backend caps one /budget/sync request at 500 entries. Large builders can
// accumulate many more per-customer keys, so reconcile in bounded batches
// instead of letting the server reject the entire snapshot.
const SYNC_BATCH_SIZE = 500;

export type Scope = 'per_customer' | 'pooled';
export type Period = 'hour' | 'day' | 'week' | 'month';

interface AccumulatorEntry {
  total_usd: number;
  event_count: number;
  last_touched: number;
  exceeded_source?: 'backend_ingest_flag';
}

interface AccumulatorKey {
  rule_id: string;
  scope: Scope;
  customer_id: string | null;
  period_start: string;
}

// Map preserves insertion order → we use that for LRU-eviction.
const accumulator = new Map<string, AccumulatorEntry>();

let syncTimer: ReturnType<typeof setInterval> | null = null;
let lruWarnedAt = 0;
let syncInFlight: Promise<void> | null = null;
let syncMissingPeriodStartWarned = false;
let syncAmbiguousPeriodStartWarned = false;
let accumulatorEpoch = 0;
const activeControllers = new Set<AbortController>();

function keyOf(k: AccumulatorKey): string | null {
  if (k.scope === 'pooled') return `${k.rule_id}:__pooled__:${k.period_start}`;
  // per_customer with no customer identity has no valid key. Callers treat
  // null as "skip" — collapsing to the pooled token here made per-customer
  // hard stops silently unenforceable for calls without a customer context
  // (events attribute those to 'anonymous', so the tokens never matched).
  if (k.customer_id === null || k.customer_id === '') return null;
  return `${k.rule_id}:${k.customer_id}:${k.period_start}`;
}

function touchEntry(key: string, entry: AccumulatorEntry): void {
  // LRU touch: delete then re-insert to move to the end.
  accumulator.delete(key);
  entry.last_touched = Date.now();
  accumulator.set(key, entry);
}

function maybeEvict(): void {
  if (accumulator.size <= LRU_MAX) return;
  const toEvict = accumulator.size - LRU_MAX;
  const iter = accumulator.keys();
  for (let i = 0; i < toEvict; i++) {
    const oldest = iter.next().value;
    if (oldest !== undefined) accumulator.delete(oldest);
  }
  const now = Date.now();
  if (now - lruWarnedAt > 5 * 60 * 1000) {
    lruWarnedAt = now;
    console.warn(`[pylva] budget accumulator LRU-evicted ${toEvict} entries (size cap ${LRU_MAX})`);
  }
}

/**
 * Fetch-or-create the entry for a key. Does not mutate total; use `add` or
 * `setFromSync` for that.
 */
function ensureEntry(key: string): AccumulatorEntry {
  let entry = accumulator.get(key);
  if (!entry) {
    entry = { total_usd: 0, event_count: 0, last_touched: Date.now() };
    accumulator.set(key, entry);
    maybeEvict();
  }
  return entry;
}

/** Read accumulator state for a key. Returns a zeroed entry if absent. */
export function get(k: AccumulatorKey): Readonly<AccumulatorEntry> {
  const key = keyOf(k);
  const entry = key === null ? undefined : accumulator.get(key);
  return entry ?? { total_usd: 0, event_count: 0, last_touched: 0 };
}

/**
 * Bump the accumulator after a call completes. Call with the ACTUAL post-call
 * cost (see core/budget_rules recordLlmSpend).
 */
export function add(k: AccumulatorKey, actual_usd: number): void {
  if (!Number.isFinite(actual_usd) || actual_usd < 0) return;
  const key = keyOf(k);
  if (key === null) return;
  const entry = ensureEntry(key);
  entry.total_usd += actual_usd;
  entry.event_count += 1;
  touchEntry(key, entry);
}

/**
 * Backend-authoritative override: called when /api/v1/events returns a
 * budget_exceeded flag. Bumps local accumulator to `limit_usd + 1` so the
 * next pre-call check for that key throws (I-T3-2, §6.4 edge row
 * "`budget_exceeded` from ingest").
 */
export function markExceededFromBackend(flag: BudgetExceededFlag): void {
  const k: AccumulatorKey = {
    rule_id: flag.rule_id,
    scope: flag.customer_id === null ? 'pooled' : 'per_customer',
    customer_id: flag.customer_id,
    period_start: flag.period_start,
  };
  const key = keyOf(k);
  if (key === null) return;
  const entry = ensureEntry(key);
  entry.total_usd = Math.max(entry.total_usd, flag.limit_usd + 1);
  entry.exceeded_source = 'backend_ingest_flag';
  touchEntry(key, entry);
}

/**
 * Replace (not add) the accumulator total for a key — used by `/budget/sync`
 * reconciliation. Spec I-T3-3: server_total_usd REPLACES local, never adds.
 */
export function setFromSync(k: AccumulatorKey, server_total_usd: number): void {
  if (!Number.isFinite(server_total_usd) || server_total_usd < 0) return;
  const key = keyOf(k);
  if (key === null) return;
  const entry = ensureEntry(key);
  entry.total_usd = server_total_usd;
  entry.exceeded_source = undefined;
  touchEntry(key, entry);
}

export interface PreCallCheckInput extends AccumulatorKey {
  estimated_usd: number;
  limit_usd: number;
}

export interface PreCallCheckResult {
  over_limit: boolean;
  accumulated_usd: number;
  projected_usd: number; // accumulated + estimated
  source?: 'backend_ingest_flag';
}

/**
 * Non-throwing pre-call check: returns whether the projected spend (current
 * accumulator + estimated next-call cost) crosses the budget. The wrapper
 * uses this and decides whether to throw (hard_stop) or emit an advisory
 * warning (soft budget).
 */
export function check(input: PreCallCheckInput): PreCallCheckResult {
  const key = keyOf(input);
  const entry = key === null ? undefined : accumulator.get(key);
  // LRU-touch on read: an actively-blocking key must not be evicted just
  // because nothing writes to it anymore (writes stop once calls block).
  if (key !== null && entry) touchEntry(key, entry);
  const accumulated_usd = entry?.total_usd ?? 0;
  const projected_usd = accumulated_usd + (input.estimated_usd > 0 ? input.estimated_usd : 0);
  return {
    // >= matches the server (computeBudgetExceededFlags / reconcileBudgetSync
    // both flag at total >= limit) so spend exactly at the limit blocks on
    // both sides of the contract.
    over_limit: projected_usd >= input.limit_usd,
    accumulated_usd,
    projected_usd,
    ...(entry?.exceeded_source ? { source: entry.exceeded_source } : {}),
  };
}

/**
 * Start the 5-minute sync loop. Safe to call multiple times — subsequent
 * calls are no-ops.
 */
export function startSyncLoop(): void {
  if (syncTimer) return;
  // First sync runs after SYNC_INTERVAL_MS; for init-time priming the SDK
  // calls `runSyncNow` explicitly from `initAccumulator`.
  syncTimer = setInterval(() => {
    void runSyncNow().catch(() => {
      /* R1 — sync failure must never crash host */
    });
  }, SYNC_INTERVAL_MS);
  // Node-only: unref so the loop doesn't keep the process alive.
  if (typeof (syncTimer as unknown as { unref?: () => void }).unref === 'function') {
    (syncTimer as unknown as { unref: () => void }).unref();
  }
}

export function stopSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

interface BudgetSyncSnapshotEntry {
  rule_id: string;
  scope: Scope;
  customer_id: string | null;
  accumulated_cost_usd: number;
  period_start: string;
  event_count: number;
}

interface BudgetSyncResponseEntry {
  rule_id: string;
  scope: Scope;
  customer_id: string | null;
  period_start?: string;
  server_total_usd: number;
}

function warnMissingPeriodStartFallback(): void {
  if (syncMissingPeriodStartWarned) return;
  syncMissingPeriodStartWarned = true;
  console.warn(
    '[pylva] /budget/sync response is missing period_start; falling back to an unambiguous legacy match',
  );
}

function warnAmbiguousPeriodStartSkip(): void {
  if (syncAmbiguousPeriodStartWarned) return;
  syncAmbiguousPeriodStartWarned = true;
  console.warn(
    '[pylva] /budget/sync response is missing period_start for multiple local periods; skipping ambiguous reconciliation',
  );
}

function findSnapshotForSyncEntry(
  snapshot: BudgetSyncSnapshotEntry[],
  responseEntry: BudgetSyncResponseEntry,
): BudgetSyncSnapshotEntry | null {
  const tupleMatches = snapshot.filter(
    (s) =>
      s.rule_id === responseEntry.rule_id &&
      s.scope === responseEntry.scope &&
      s.customer_id === responseEntry.customer_id,
  );
  if (typeof responseEntry.period_start === 'string') {
    return tupleMatches.find((s) => s.period_start === responseEntry.period_start) ?? null;
  }
  if (tupleMatches.length === 1) {
    warnMissingPeriodStartFallback();
    return tupleMatches[0]!;
  }
  if (tupleMatches.length > 1) warnAmbiguousPeriodStartSkip();
  return null;
}

/**
 * POST the current accumulator snapshot to /api/v1/budget/sync and overwrite
 * local entries with the server truth. Coalesced via `syncInFlight` so
 * concurrent callers share one request.
 */
export async function runSyncNow(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  const owner = accumulatorEpoch;
  const promise = doSync(owner);
  const wrapped = promise.finally(() => {
    if (syncInFlight === wrapped) syncInFlight = null;
  });
  syncInFlight = wrapped;
  return syncInFlight;
}

async function doSync(owner: number): Promise<void> {
  if (!getConfig()) return;
  if (accumulator.size === 0) return;

  const snapshot: BudgetSyncSnapshotEntry[] = [...accumulator.entries()].map(
    ([compositeKey, entry]) => {
      // Key shape is `${rule_id}:${scope_token}:${period_start}`. period_start
      // is an ISO-8601 timestamp that itself contains colons (e.g.
      // `2026-06-09T00:00:00.000Z`), so we split on the FIRST two colons only and
      // keep the remainder intact. A bare `split(':')` with array destructuring
      // truncates period_start at the first inner colon (`2026-06-09T00`),
      // corrupting the value POSTed to /budget/sync and making setFromSync write
      // to a phantom key that never reconciles the real accumulator entry
      // (I-T3-3). Mirrors the Python SDK's `split(':', 2)`.
      const parts = compositeKey.split(':');
      const rule_id = parts[0] ?? '';
      const scope_token = parts[1] ?? '';
      const period_start = parts.slice(2).join(':');
      const scope: Scope = scope_token === '__pooled__' ? 'pooled' : 'per_customer';
      const customer_id = scope === 'pooled' ? null : scope_token;
      return {
        rule_id,
        scope,
        customer_id,
        accumulated_cost_usd: entry.total_usd,
        period_start,
        event_count: entry.event_count,
      };
    },
  );

  for (let offset = 0; offset < snapshot.length; offset += SYNC_BATCH_SIZE) {
    if (owner !== accumulatorEpoch) return;
    const batch = snapshot.slice(offset, offset + SYNC_BATCH_SIZE);
    const controller = new AbortController();
    activeControllers.add(controller);
    try {
      const res = await coreRuntime.authenticatedRequest({
        route: AuthenticatedRoute.BUDGET_SYNC,
        body: JSON.stringify({ entries: batch }),
        signal: controller.signal,
      });
      if (owner !== accumulatorEpoch) return;
      if (!res.ok) continue; // R5 passthrough — reconcile other batches if possible
      const body = JSON.parse(res.bodyText) as {
        entries?: BudgetSyncResponseEntry[];
      };
      if (owner !== accumulatorEpoch) return;
      const entries = body.entries ?? [];
      for (const r of entries) {
        if (owner !== accumulatorEpoch) return;
        const snap = findSnapshotForSyncEntry(batch, r);
        if (!snap) continue;
        setFromSync(
          {
            rule_id: r.rule_id,
            scope: r.scope,
            customer_id: r.customer_id,
            period_start: snap.period_start,
          },
          r.server_total_usd,
        );
      }
    } catch {
      // A transport failure applies to the endpoint, not one malformed batch.
      // Stop here so a large snapshot cannot turn one outage into up to 100
      // sequential retries (R1/R5). The next scheduled sync retries everything.
      return;
    } finally {
      activeControllers.delete(controller);
    }
  }
}

/**
 * Prime the accumulator on SDK init. Non-blocking: kicked off by `init()` via
 * `void initAccumulator()`. Safe under cold-boot + backend-down (fresh-boot
 * passthrough — I-T3-1).
 */
export async function initAccumulator(): Promise<void> {
  startSyncLoop();
  await runSyncNow();
}

// Test helper: drains local state so tests don't leak between runs.
export function _resetAccumulatorForTests(): void {
  resetAccumulator();
}

function resetAccumulator(): void {
  accumulatorEpoch += 1;
  for (const controller of activeControllers) controller.abort();
  activeControllers.clear();
  accumulator.clear();
  lruWarnedAt = 0;
  syncMissingPeriodStartWarned = false;
  syncAmbiguousPeriodStartWarned = false;
  syncInFlight = null;
  stopSyncLoop();
}

export function _resetAccumulatorForIdentityChange(): void {
  resetAccumulator();
}

registerIdentityResetter(_resetAccumulatorForIdentityChange);
