import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the queryCostEvents retry through the REAL @clickhouse/client
// transport (no query mock) against an in-process HTTP server, reproducing
// the first-request-after-idle failure: a keep-alive socket the server has
// already dropped. Only config/logger are mocked.

const state = vi.hoisted(() => ({ url: '' }));
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));

vi.mock('../../src/lib/config.js', () => ({
  env: {
    get CLICKHOUSE_URL() {
      return state.url;
    },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: warnMock }),
  },
}));

type Behavior = 'destroy-first' | 'ok';
let behavior: Behavior = 'ok';
let requestCount = 0;

const server = http.createServer((req, res) => {
  requestCount += 1;
  if (behavior === 'destroy-first' && requestCount === 1) {
    // Simulate the LB/server dropping the connection mid-request — the
    // client observes ECONNRESET / socket hang up.
    req.socket.destroy();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":1}\n');
});

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { queryCostEvents, closeClickhouse } = await import('../../src/lib/clickhouse/client.js');

afterAll(async () => {
  await closeClickhouse();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe('queryCostEvents retry over the real HTTP transport', () => {
  beforeEach(() => {
    requestCount = 0;
    warnMock.mockClear();
  });

  it('recovers when the server drops the first connection', async () => {
    behavior = 'destroy-first';

    const rows = await queryCostEvents('builder-1', 'SELECT 1 AS ok', {}, {
      queryLabel: 'test.retry_transport',
      timeoutMs: 5_000,
    });

    expect(rows).toEqual([{ ok: 1 }]);
    expect(requestCount).toBe(2);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [payload, message] = warnMock.mock.calls[0] ?? [];
    expect(message).toBe('clickhouse query failed');
    expect(payload).toEqual(
      expect.objectContaining({ attempt: 1, max_attempts: 2, will_retry: true }),
    );
  });

  it('succeeds without retrying when the transport is healthy', async () => {
    behavior = 'ok';

    const rows = await queryCostEvents('builder-1', 'SELECT 1 AS ok');

    expect(rows).toEqual([{ ok: 1 }]);
    expect(requestCount).toBe(1);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
