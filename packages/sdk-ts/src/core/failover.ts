// B4-T1 reliability failover state machine. Per-SDK-instance only — no
// shared state across processes (b4 plan D19: split-brain is acceptable
// because partial failover is safer than coordinating).
//
// Per Rev-2 O32, the sliding error window is keyed by primary_provider
// only — one counter per (builder, primary_provider). Each SDK process
// already represents one builder, so primary_provider is sufficient.
// The earlier per-customer keying meant a high-volume builder with
// thousands of customers would never trip for sparse-traffic customers
// because their per-customer window stayed empty. Plan accepted "OK to
// over-failover for v1" in exchange for a single fast-tripping counter.
//
// Trigger: error rate > trigger_pct over window_seconds. While active,
// recordOutcome() returns the backup provider so the wrapper routes
// there. Recovery: error rate stays below recover_pct for
// recover_after_seconds → flip back. Sparse traffic 30-min probe (D24):
// after `recovery_probe_after_seconds` on backup, the wrapper attempts
// one primary call; on success the recovery window starts.

import type { ReliabilityFailoverConfig } from '@pylva/shared/rules';
import { registerIdentityResetter } from './identity_registry.js';

export interface FailoverEventResult {
  /** The provider the wrapper should target on the next call. */
  provider: string;
  /** True iff the engine just transitioned primary → backup. */
  triggered: boolean;
  /** True iff the engine just transitioned backup → primary. */
  recovered: boolean;
}

interface WindowSample {
  ts: number;
  ok: boolean;
}

interface InstanceState {
  active: boolean;
  enteredAt: number;
  lastProbeAt: number;
  belowSince: number | null; // start of consecutive < recover_pct period
  samples: WindowSample[];
}

const STATE = new Map<string, InstanceState>();

function key(cfg: ReliabilityFailoverConfig): string {
  // Per O32 — single counter per primary_provider for the whole SDK
  // process. customer_id stays in cfg for the matching/scope layer
  // (which rules apply to which calls) but is not part of the trip key.
  return cfg.primary_provider;
}

function pruneWindow(samples: WindowSample[], windowMs: number, now: number): void {
  const cutoff = now - windowMs;
  while (samples.length > 0 && samples[0]!.ts < cutoff) samples.shift();
}

function errorRate(samples: WindowSample[]): number {
  if (samples.length === 0) return 0;
  const errors = samples.reduce((n, s) => (s.ok ? n : n + 1), 0);
  return errors / samples.length;
}

export function ensureState(cfg: ReliabilityFailoverConfig): InstanceState {
  const k = key(cfg);
  let s = STATE.get(k);
  if (!s) {
    s = { active: false, enteredAt: 0, lastProbeAt: 0, belowSince: null, samples: [] };
    STATE.set(k, s);
  }
  return s;
}

/**
 * Returns the provider the wrapper should target. Pure-read — does not
 * record outcomes. Wrappers call this BEFORE issuing the request, then
 * call recordOutcome after the response.
 */
export function selectProvider(cfg: ReliabilityFailoverConfig, now: number = Date.now()): string {
  const s = ensureState(cfg);
  if (!s.active) return cfg.primary_provider;

  // Sparse-traffic probe: after recovery_probe_after_seconds on backup,
  // attempt one primary call. selectProvider doesn't mutate state — the
  // probe transition happens in recordOutcome when the probe call
  // succeeds.
  const probeAfterMs = cfg.recovery_probe_after_seconds * 1000;
  const sinceEntered = now - s.enteredAt;
  const sinceLastProbe = now - s.lastProbeAt;
  if (sinceEntered > probeAfterMs && sinceLastProbe > probeAfterMs) {
    s.lastProbeAt = now;
    return cfg.primary_provider; // probe call goes to primary
  }
  return cfg.backup_provider;
}

/**
 * Record the outcome of a call (ok or error). Returns whether a state
 * transition occurred (triggered or recovered).
 */
export function recordOutcome(
  cfg: ReliabilityFailoverConfig,
  ok: boolean,
  now: number = Date.now(),
): FailoverEventResult {
  const s = ensureState(cfg);
  const windowMs = cfg.window_seconds * 1000;
  s.samples.push({ ts: now, ok });
  pruneWindow(s.samples, windowMs, now);

  const rate = errorRate(s.samples) * 100;
  let triggered = false;
  let recovered = false;

  if (!s.active) {
    if (rate > cfg.trigger_error_rate_pct) {
      s.active = true;
      s.enteredAt = now;
      s.lastProbeAt = now; // start the probe clock from entry
      s.belowSince = null;
      triggered = true;
    }
  } else {
    if (rate <= cfg.recover_error_rate_pct) {
      if (s.belowSince === null) s.belowSince = now;
      const belowMs = now - s.belowSince;
      if (belowMs >= cfg.recover_after_seconds * 1000) {
        s.active = false;
        s.belowSince = null;
        s.samples = []; // fresh window for the next trigger
        recovered = true;
      }
    } else {
      s.belowSince = null; // streak broken
    }
  }

  return {
    provider: s.active ? cfg.backup_provider : cfg.primary_provider,
    triggered,
    recovered,
  };
}

export function isActive(cfg: ReliabilityFailoverConfig): boolean {
  return ensureState(cfg).active;
}

// Test-only reset.
export function _resetFailoverForTests(): void {
  STATE.clear();
}

registerIdentityResetter(_resetFailoverForTests);
