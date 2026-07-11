import { beforeEach, describe, expect, it, vi } from 'vitest';

const { closeMock, createClientMock, insertMock, queryMock, warnMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  createClientMock: vi.fn(),
  insertMock: vi.fn(),
  queryMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@clickhouse/client', () => ({
  createClient: createClientMock,
}));

vi.mock('../../src/lib/config.js', () => ({
  env: { CLICKHOUSE_URL: 'https://clickhouse.example.com:8443' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ warn: warnMock }),
  },
}));

createClientMock.mockReturnValue({
  close: closeMock,
  insert: insertMock,
  query: queryMock,
});

const { insertCostEvents, queryCostEvents } = await import('../../src/lib/clickhouse/client.js');

describe('ClickHouse client', () => {
  beforeEach(() => {
    insertMock.mockClear();
    queryMock.mockReset();
    warnMock.mockClear();
  });

  it('pins keep-alive and request timeout globally without insert settings', () => {
    expect(createClientMock).toHaveBeenCalledWith({
      url: 'https://clickhouse.example.com:8443',
      keep_alive: { enabled: true, idle_socket_ttl: 2500 },
      request_timeout: 30_000,
    });
  });

  it('waits for async insert flush on cost event inserts', async () => {
    const events = [{ builder_id: 'builder-1', span_id: 'span-1' }];

    await insertCostEvents(events);

    expect(insertMock).toHaveBeenCalledWith({
      table: 'cost_events',
      values: events,
      format: 'JSONEachRow',
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
  });

  it('forwards query id, timeout abort signal, query params, and query settings', async () => {
    const jsonMock = vi.fn().mockResolvedValue([{ answer: 42 }]);
    queryMock.mockResolvedValue({ json: jsonMock });

    const rows = await queryCostEvents(
      'builder-1',
      'SELECT {limit:UInt32} AS answer',
      { limit: 42 },
      {
        queryId: 'dashboard.overview',
        queryLabel: 'dashboard.overview',
        timeoutMs: 8_000,
        clickhouseSettings: { log_comment: 'dashboard overview' },
      },
    );

    expect(rows).toEqual([{ answer: 42 }]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      query: 'SELECT {limit:UInt32} AS answer',
      query_params: { builder_id: 'builder-1', limit: 42 },
      format: 'JSONEachRow',
      query_id: 'dashboard.overview',
      clickhouse_settings: {
        max_execution_time: 8,
        log_comment: 'dashboard overview',
      },
    });
    expect(call.abort_signal).toBeDefined();
    expect(call.abort_signal.aborted).toBe(false);
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it('logs sanitized query failure context before rethrowing', async () => {
    queryMock.mockRejectedValue(
      new Error(
        'Timeout error. url=https://user:secret@clickhouse.example.com:8443 authorization=Bearer abc123 password=hunter2',
      ),
    );

    await expect(
      queryCostEvents('builder-1', 'SELECT 1', {}, {
        queryId: 'dashboard.top',
        queryLabel: 'dashboard.top',
        timeoutMs: 8_000,
      }),
    ).rejects.toThrow('Timeout error.');

    const [payload, message] = warnMock.mock.calls[0] ?? [];
    expect(message).toBe('clickhouse query failed');
    expect(payload).toEqual(
      expect.objectContaining({
        builder_id: 'builder-1',
        query_id: 'dashboard.top',
        query_label: 'dashboard.top',
        elapsed_ms: expect.any(Number),
      }),
    );
    expect(payload.error).toContain('Timeout error.');
    expect(payload.error).toContain('[url]');
    expect(payload.error).toContain('authorization=[REDACTED]');
    expect(payload.error).toContain('password=[REDACTED]');
    expect(payload.error).not.toContain('abc123');
    expect(payload.error).not.toContain('hunter2');
    expect(payload.error).not.toContain('user:secret@clickhouse');
  });

  describe('transient-failure retry', () => {
    function socketError(code: string): Error {
      return Object.assign(new Error('socket hang up'), { code });
    }

    it('retries once on a connection reset and returns the rows', async () => {
      const jsonMock = vi.fn().mockResolvedValue([{ ok: 1 }]);
      queryMock.mockRejectedValueOnce(socketError('ECONNRESET'));
      queryMock.mockResolvedValueOnce({ json: jsonMock });

      const rows = await queryCostEvents('builder-1', 'SELECT 1', {}, {
        queryLabel: 'dashboard.overview',
      });

      expect(rows).toEqual([{ ok: 1 }]);
      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(warnMock).toHaveBeenCalledTimes(1);
      const [payload, message] = warnMock.mock.calls[0] ?? [];
      expect(message).toBe('clickhouse query failed');
      expect(payload).toEqual(
        expect.objectContaining({ attempt: 1, max_attempts: 2, will_retry: true }),
      );
    });

    it('does not retry timeouts or aborts — that would double the latency budget', async () => {
      const errors = [
        new Error('Timeout error.'),
        Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }),
        Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:8443'), { code: 'ETIMEDOUT' }),
      ];

      for (const error of errors) {
        queryMock.mockReset();
        warnMock.mockClear();
        queryMock.mockRejectedValue(error);

        await expect(
          queryCostEvents('builder-1', 'SELECT 1', {}, { timeoutMs: 8_000 }),
        ).rejects.toThrow(error.message);
        expect(queryMock).toHaveBeenCalledTimes(1);
        expect(warnMock.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({ attempt: 1, will_retry: false }),
        );
      }
    });

    it('does not retry non-transient query errors', async () => {
      queryMock.mockRejectedValue(new Error('Code: 62. DB::Exception: Syntax error'));

      await expect(queryCostEvents('builder-1', 'SELEC 1')).rejects.toThrow('Syntax error');
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ attempt: 1, will_retry: false }),
      );
    });

    it('uses a fresh query_id and abort signal on the retry attempt', async () => {
      queryMock.mockRejectedValueOnce(socketError('EPIPE'));
      queryMock.mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await queryCostEvents('builder-1', 'SELECT 1', {}, {
        queryId: 'dashboard.overview.uuid-1',
        timeoutMs: 8_000,
      });

      const first = queryMock.mock.calls[0]?.[0];
      const second = queryMock.mock.calls[1]?.[0];
      expect(first.query_id).toBe('dashboard.overview.uuid-1');
      expect(second.query_id).toBe('dashboard.overview.uuid-1.retry1');
      expect(second.abort_signal).toBeDefined();
      expect(second.abort_signal).not.toBe(first.abort_signal);
      expect(second.abort_signal.aborted).toBe(false);
    });

    it('gives up after the second transient failure', async () => {
      queryMock.mockRejectedValue(socketError('ECONNRESET'));

      await expect(queryCostEvents('builder-1', 'SELECT 1')).rejects.toThrow('socket hang up');
      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(warnMock).toHaveBeenCalledTimes(2);
      expect(warnMock.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ attempt: 2, will_retry: false }),
      );
    });

    it('omits query_id on both attempts when the caller passes none', async () => {
      queryMock.mockRejectedValueOnce(socketError('ECONNRESET'));
      queryMock.mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([]) });

      await queryCostEvents('builder-1', 'SELECT 1');

      expect('query_id' in (queryMock.mock.calls[0]?.[0] ?? {})).toBe(false);
      expect('query_id' in (queryMock.mock.calls[1]?.[0] ?? {})).toBe(false);
    });

    it('retries when the result body fails mid-stream', async () => {
      queryMock.mockResolvedValueOnce({
        json: vi.fn().mockRejectedValue(socketError('ECONNRESET')),
      });
      queryMock.mockResolvedValueOnce({ json: vi.fn().mockResolvedValue([{ ok: 1 }]) });

      await expect(queryCostEvents('builder-1', 'SELECT 1')).resolves.toEqual([{ ok: 1 }]);
      expect(queryMock).toHaveBeenCalledTimes(2);
    });
  });
});
