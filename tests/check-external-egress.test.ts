import { describe, expect, it, vi } from 'vitest';
import { runExternalEgressChecks } from '../scripts/check-external-egress';

const response = (status: number, body = '') => ({
  body,
  headers: {},
  status,
  statusText: status >= 500 ? 'Unavailable' : 'Expected',
});

describe('runExternalEgressChecks', () => {
  it('accepts expected provider HTTP responses and prints no response content', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(404, 'github-secret-body'))
      .mockResolvedValueOnce(response(400, 'google-secret-body'));
    const lines: string[] = [];
    const times = [0, 12, 12, 20];

    const exitCode = await runExternalEgressChecks({
      fetcher,
      now: () => times.shift() ?? 20,
      write: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: 'github',
        timeoutMs: 10_000,
        url: 'https://github.com/login/oauth/access_token',
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        target: 'google_oauth',
        url: 'https://oauth2.googleapis.com/token',
      }),
    );
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { check: 'external_egress', duration_ms: 12, status: 404, target: 'github' },
      { check: 'external_egress', duration_ms: 8, status: 400, target: 'google_oauth' },
    ]);
    expect(lines.join(' ')).not.toContain('secret-body');
  });

  it('fails on provider 5xx without printing bodies', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(503, 'provider internals'))
      .mockResolvedValueOnce(response(400));
    const lines: string[] = [];

    await expect(
      runExternalEgressChecks({ fetcher, write: (line) => lines.push(line) }),
    ).resolves.toBe(1);
    expect(lines.join(' ')).not.toContain('provider internals');
  });

  it('fails safely on transport errors and emits the nested code only', async () => {
    const failure = new TypeError('fetch failed for oauth-code-secret', {
      cause: Object.assign(new Error('Invalid IP address: undefined'), {
        code: 'ERR_INVALID_IP_ADDRESS',
      }),
    });
    const fetcher = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(response(400));
    const lines: string[] = [];

    await expect(
      runExternalEgressChecks({ fetcher, write: (line) => lines.push(line) }),
    ).resolves.toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      cause_code: 'ERR_INVALID_IP_ADDRESS',
      error_name: 'TypeError',
      target: 'github',
    });
    expect(lines.join(' ')).not.toContain('oauth-code-secret');
    expect(lines.join(' ')).not.toContain('Invalid IP address');
  });
});
