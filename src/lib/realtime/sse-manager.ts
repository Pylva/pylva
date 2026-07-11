// B3-T2 — SSE connection bookkeeping. I-SSE-2: max 50 SSE connections per
// builder, 51st returns 429 (caller falls back to polling). Cleanup on
// disconnect releases the slot.

const MAX_CONNECTIONS_PER_BUILDER = 50;

const connectionCounts = new Map<string, number>();

export interface ConnectionLeaseResult {
  ok: true;
  release: () => void;
}

export interface ConnectionLeaseDenied {
  ok: false;
  reason: 'limit_reached';
  current: number;
  limit: number;
}

export function acquireSseConnection(
  builderId: string,
): ConnectionLeaseResult | ConnectionLeaseDenied {
  const current = connectionCounts.get(builderId) ?? 0;
  if (current >= MAX_CONNECTIONS_PER_BUILDER) {
    return {
      ok: false,
      reason: 'limit_reached',
      current,
      limit: MAX_CONNECTIONS_PER_BUILDER,
    };
  }
  connectionCounts.set(builderId, current + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const count = connectionCounts.get(builderId) ?? 0;
      const next = Math.max(0, count - 1);
      if (next === 0) connectionCounts.delete(builderId);
      else connectionCounts.set(builderId, next);
    },
  };
}

export function getSseConnectionCount(builderId: string): number {
  return connectionCounts.get(builderId) ?? 0;
}

export function getSseConnectionLimit(): number {
  return MAX_CONNECTIONS_PER_BUILDER;
}

// Test-only reset hook.
export function _resetSseManagerForTests(): void {
  connectionCounts.clear();
}
