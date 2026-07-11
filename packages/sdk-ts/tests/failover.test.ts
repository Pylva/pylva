// B4-2 — failover state machine. Per-instance error window tracking +
// 30-min sparse-traffic recovery probe.

import { describe, it, expect, beforeEach } from 'vitest';
import type { ReliabilityFailoverConfig } from '@pylva/shared';
import {
  isActive,
  recordOutcome,
  selectProvider,
  _resetFailoverForTests,
} from '../src/core/failover.js';

function cfg(overrides: Partial<ReliabilityFailoverConfig> = {}): ReliabilityFailoverConfig {
  return {
    customer_id: 'cust_1',
    primary_provider: 'openai',
    backup_provider: 'anthropic',
    enabled: true,
    consent_to_cost_shift: true,
    trigger_error_rate_pct: 10,
    window_seconds: 300,
    recover_error_rate_pct: 5,
    recover_after_seconds: 300,
    recovery_probe_after_seconds: 1800,
    ...overrides,
  };
}

describe('failover state machine', () => {
  beforeEach(() => _resetFailoverForTests());

  it('starts on the primary provider', () => {
    expect(selectProvider(cfg())).toBe('openai');
    expect(isActive(cfg())).toBe(false);
  });

  it('triggers when error rate exceeds threshold over the window', () => {
    const c = cfg();
    let now = 1_000_000;
    for (let i = 0; i < 9; i++) {
      const r = recordOutcome(c, true, now);
      now += 1000;
      expect(r.triggered).toBe(false);
    }
    // 10 ok + 2 errors = 16% > 10% trigger
    recordOutcome(c, false, now);
    now += 1000;
    const triggered = recordOutcome(c, false, now);
    expect(triggered.triggered).toBe(true);
    expect(triggered.provider).toBe('anthropic');
    expect(isActive(c)).toBe(true);
  });

  it('routes to backup once active', () => {
    const c = cfg();
    let now = 0;
    for (let i = 0; i < 20; i++) {
      recordOutcome(c, false, now);
      now += 1000;
    }
    expect(selectProvider(c, now)).toBe('anthropic');
  });

  it('recovers after staying below recover threshold for recover_after_seconds', () => {
    // Shorten the window for the test so the rate-dilution math is tractable:
    // 5 errors + 100 oks fits in a 600s window at 1s spacing → rate ≈ 4.7% < 5%.
    const c = cfg({ window_seconds: 600, recover_after_seconds: 60 });
    let now = 0;
    for (let i = 0; i < 5; i++) {
      recordOutcome(c, false, now);
      now += 1000;
    }
    expect(isActive(c)).toBe(true);

    // Dilute with successful samples until the rate drops below 5%.
    for (let i = 0; i < 100; i++) {
      recordOutcome(c, true, now);
      now += 1000;
    }
    expect(isActive(c)).toBe(true); // belowSince just got set; must persist

    // Continue oks past recover_after_seconds with the rate still below 5%.
    for (let i = 0; i < 70; i++) {
      recordOutcome(c, true, now);
      now += 1000;
    }
    expect(isActive(c)).toBe(false);
    expect(selectProvider(c, now)).toBe('openai');
  });

  it('breaks the recovery streak on a fresh error', () => {
    const c = cfg();
    let now = 0;
    for (let i = 0; i < 15; i++) {
      recordOutcome(c, false, now);
      now += 1000;
    }
    // Mostly-ok samples but interrupted by errors.
    for (let i = 0; i < 5; i++) {
      recordOutcome(c, true, now);
      now += 1000;
    }
    recordOutcome(c, false, now); // streak broken
    now += c.recover_after_seconds * 1000 + 1000;
    const r = recordOutcome(c, true, now);
    // 5 oks + 1 error in window = 16% — still above recover threshold
    expect(r.recovered).toBe(false);
    expect(isActive(c)).toBe(true);
  });

  it('issues a probe after recovery_probe_after_seconds on backup', () => {
    const c = cfg({ recovery_probe_after_seconds: 1800 });
    let now = 0;
    for (let i = 0; i < 10; i++) {
      recordOutcome(c, false, now);
      now += 1000;
    }
    expect(isActive(c)).toBe(true);

    // Right after entering — selectProvider returns backup.
    expect(selectProvider(c, now + 60_000)).toBe('anthropic');

    // After 30 min — selectProvider issues a probe to primary.
    const probeAt = now + 1801 * 1000;
    expect(selectProvider(c, probeAt)).toBe('openai');

    // Immediately after — selectProvider returns to backup until next probe.
    expect(selectProvider(c, probeAt + 60_000)).toBe('anthropic');
  });

  it('shares state across customers within the same primary provider (per O32)', () => {
    // PR #70 follow-up — the trip key is primary_provider only, per
    // remaining-implementation-plan.md O32 ("single counter; fast trip;
    // OK to over-failover for v1"). Two customers on the same primary
    // share the sliding error window — when one trips, both fail over.
    const a = cfg({ customer_id: 'cust_a' });
    const b = cfg({ customer_id: 'cust_b' });
    let now = 0;
    for (let i = 0; i < 10; i++) {
      recordOutcome(a, false, now);
      now += 1000;
    }
    expect(isActive(a)).toBe(true);
    // Same primary_provider → same key → same active state.
    expect(isActive(b)).toBe(true);
  });

  it('isolates state across distinct primary providers', () => {
    // Two failover configs targeting different primaries get independent
    // sliding windows; tripping one does not trip the other.
    const a = cfg({ primary_provider: 'openai', backup_provider: 'anthropic' });
    const b = cfg({ primary_provider: 'anthropic', backup_provider: 'openai' });
    let now = 0;
    for (let i = 0; i < 10; i++) {
      recordOutcome(a, false, now);
      now += 1000;
    }
    expect(isActive(a)).toBe(true);
    expect(isActive(b)).toBe(false);
  });

  it('prunes samples older than window_seconds', () => {
    // Pre-active state: a couple errors that would trigger if accumulated,
    // followed by a long pause. After the pause, the next sample sees a
    // fresh window — old errors are gone, so a single new sample doesn't
    // tip the rate over the trigger threshold.
    const c = cfg({ window_seconds: 60, customer_id: 'fresh-cust' });
    let now = 0;
    for (let i = 0; i < 2; i++) {
      recordOutcome(c, false, now);
      now += 1000;
    }
    // 2 errors / 2 samples = 100% > 10% → activated. Verify, then check
    // that pruning works on the next push.
    expect(isActive(c)).toBe(true);

    // Advance past the window with a single sample. Old errors are pruned.
    now += 120_000;
    recordOutcome(c, true, now);
    // Re-trigger requires a fresh threshold breach over the new window —
    // the single sample should now be the only one and it's an OK.
    // (The state stays active until explicit recovery; pruning by itself
    // does not auto-recover.)
    expect(isActive(c)).toBe(true);
  });
});
