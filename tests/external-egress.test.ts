import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  invokeCommand: vi.fn(function InvokeCommand(input: unknown) {
    return { input };
  }),
  lambdaClient: vi.fn(function LambdaClient() {
    return { send: mocks.lambdaSend };
  }),
  lambdaSend: vi.fn(),
}));

const testEnv = vi.hoisted(() => ({
  EGRESS_BROKER_FUNCTION_NAME: undefined as string | undefined,
}));

vi.mock('../src/lib/external-egress-config.js', () => ({ externalEgressEnv: testEnv }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mocks.fetch };
});
vi.mock('@aws-sdk/client-lambda', () => ({
  InvokeCommand: mocks.invokeCommand,
  LambdaClient: mocks.lambdaClient,
}));

import { externalFetch, _internal } from '../src/lib/external-egress';

afterEach(() => {
  testEnv.EGRESS_BROKER_FUNCTION_NAME = undefined;
  mocks.fetch.mockReset();
  mocks.lambdaClient.mockClear();
  mocks.invokeCommand.mockClear();
  mocks.lambdaSend.mockReset();
});

describe('external egress guard', () => {
  it('rejects custom webhook localhost and private IP targets before fetch', async () => {
    await expect(
      externalFetch({
        target: 'custom_webhook',
        url: 'https://localhost/hook',
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/not public/);

    for (const url of [
      'https://10.0.0.1/hook',
      'https://127.0.0.2/hook',
      'https://[fd12:3456::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://[::ffff:7f00:1]/hook',
      'https://[64:ff9b::a00:1]/hook',
    ]) {
      await expect(
        externalFetch({ target: 'custom_webhook', url, method: 'POST', body: '{}' }),
      ).rejects.toThrow(/not public/);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('rejects non-https, provider host drift, and lookalike domains', async () => {
    await expect(
      externalFetch({ target: 'github', url: 'http://github.com/login/oauth/access_token' }),
    ).rejects.toThrow(/https/);
    await expect(
      externalFetch({ target: 'slack', url: 'https://example.com/services/nope' }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      externalFetch({ target: 'github', url: 'https://evilgithub.com/login/oauth/access_token' }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      externalFetch({ target: 'google_oauth', url: 'https://accounts.google.com/o/oauth2/auth' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('keeps the known-host map limited to real externalFetch callers', () => {
    expect(_internal.hostnameAllowed('github', 'api.github.com')).toBe(true);
    expect(_internal.hostnameAllowed('github', 'uploads.api.github.com')).toBe(true);
    expect(_internal.hostnameAllowed('google_oauth', 'oauth2.googleapis.com')).toBe(true);
    expect(_internal.hostnameAllowed('google_oauth', 'openidconnect.googleapis.com')).toBe(true);
    expect(_internal.hostnameAllowed('google_oauth', 'accounts.google.com')).toBe(false);
    expect(_internal.hostnameAllowed('litellm', 'raw.githubusercontent.com')).toBe(true);
  });

  it('uses the Undici dispatcher and applies only positive timeouts', async () => {
    mocks.fetch.mockImplementation(async () => new Response('ok', { status: 200 }));

    await externalFetch({
      target: 'slack',
      url: 'https://hooks.slack.com/services/test',
      method: 'POST',
      body: '{}',
      timeoutMs: 15_000,
    });
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: expect.anything(),
      method: 'POST',
      signal: expect.any(AbortSignal),
    });

    await externalFetch({
      target: 'slack',
      url: 'https://hooks.slack.com/services/test',
      method: 'POST',
      body: '{}',
      timeoutMs: 0,
    });
    expect(mocks.fetch.mock.calls[1]?.[1]).toMatchObject({ signal: undefined });
  });
});

describe('brokered external egress', () => {
  it('validates and invokes the configured broker without direct fetch', async () => {
    testEnv.EGRESS_BROKER_FUNCTION_NAME = 'pylva-staging-public-api-egress-broker';
    mocks.lambdaSend.mockResolvedValue({
      Payload: Buffer.from(
        JSON.stringify({
          status: 202,
          statusText: 'Accepted',
          headers: { 'content-type': 'text/plain' },
          body: 'brokered',
        }),
      ),
    });

    const response = await externalFetch({
      target: 'github',
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
      body: 'code=test',
    });

    expect(response).toMatchObject({ status: 202, body: 'brokered' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        FunctionName: 'pylva-staging-public-api-egress-broker',
        InvocationType: 'RequestResponse',
        Payload: expect.any(Buffer),
      }),
    );
  });

  it('rejects disallowed requests before invoking the broker', async () => {
    testEnv.EGRESS_BROKER_FUNCTION_NAME = 'broker';
    await expect(
      externalFetch({ target: 'github', url: 'https://attacker.example/token' }),
    ).rejects.toThrow(/not allowed/);
    expect(mocks.lambdaSend).not.toHaveBeenCalled();
  });

  it('uses stable safe codes for Lambda and malformed-response failures', async () => {
    testEnv.EGRESS_BROKER_FUNCTION_NAME = 'broker';
    mocks.lambdaSend.mockResolvedValueOnce({ FunctionError: 'Unhandled' });
    await expect(
      externalFetch({ target: 'github', url: 'https://github.com/login/oauth/access_token' }),
    ).rejects.toMatchObject({ code: 'EGRESS_BROKER_FAILED' });

    mocks.lambdaSend.mockResolvedValueOnce({ Payload: Buffer.from('not-json') });
    await expect(
      externalFetch({ target: 'github', url: 'https://github.com/login/oauth/access_token' }),
    ).rejects.toMatchObject({ code: 'EGRESS_BROKER_INVALID_RESPONSE' });

    mocks.lambdaSend.mockResolvedValueOnce({
      Payload: Buffer.from(JSON.stringify({ status: 200 })),
    });
    await expect(
      externalFetch({ target: 'github', url: 'https://github.com/login/oauth/access_token' }),
    ).rejects.toMatchObject({ code: 'EGRESS_BROKER_INVALID_RESPONSE' });

    for (const malformed of [
      { status: 99, statusText: 'Invalid', headers: {}, body: '' },
      { status: 200, statusText: 'OK', headers: [], body: '' },
      { status: 200, statusText: 'OK', headers: { 'content-type': 123 }, body: '' },
    ]) {
      mocks.lambdaSend.mockResolvedValueOnce({
        Payload: Buffer.from(JSON.stringify(malformed)),
      });
      await expect(
        externalFetch({ target: 'github', url: 'https://github.com/login/oauth/access_token' }),
      ).rejects.toMatchObject({ code: 'EGRESS_BROKER_INVALID_RESPONSE' });
    }
  });
});
