// B3-T2 — connection-slot accounting unit tests (I-SSE-2).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  acquireSseConnection,
  getSseConnectionCount,
  getSseConnectionLimit,
  _resetSseManagerForTests,
} from '../../src/lib/realtime/sse-manager.js';

describe('sse-manager (I-SSE-2 connection cap)', () => {
  beforeEach(() => {
    _resetSseManagerForTests();
  });

  it('grants slots up to the per-builder limit', () => {
    const limit = getSseConnectionLimit();
    for (let i = 0; i < limit; i++) {
      const lease = acquireSseConnection('builder-1');
      expect(lease.ok).toBe(true);
    }
    expect(getSseConnectionCount('builder-1')).toBe(limit);
  });

  it('denies the (limit+1)th connection with limit_reached', () => {
    const limit = getSseConnectionLimit();
    for (let i = 0; i < limit; i++) acquireSseConnection('builder-1');
    const denied = acquireSseConnection('builder-1');
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe('limit_reached');
      expect(denied.limit).toBe(limit);
      expect(denied.current).toBe(limit);
    }
  });

  it('release() frees the slot for a new connection', () => {
    const lease = acquireSseConnection('builder-1');
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    expect(getSseConnectionCount('builder-1')).toBe(1);
    lease.release();
    expect(getSseConnectionCount('builder-1')).toBe(0);
  });

  it('release() is idempotent (double-release does not double-free)', () => {
    const lease = acquireSseConnection('builder-1');
    if (!lease.ok) throw new Error('expected lease');
    lease.release();
    lease.release();
    expect(getSseConnectionCount('builder-1')).toBe(0);
  });

  it('isolates count per builder', () => {
    acquireSseConnection('builder-A');
    acquireSseConnection('builder-A');
    acquireSseConnection('builder-B');
    expect(getSseConnectionCount('builder-A')).toBe(2);
    expect(getSseConnectionCount('builder-B')).toBe(1);
  });
});
