import type { LookupAddress, LookupOptions } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  callbackLookup: vi.fn(),
  fetch: vi.fn(),
  promisesLookup: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ lookup: mocks.promisesLookup }));
vi.mock('node:dns', () => ({ lookup: mocks.callbackLookup }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mocks.fetch };
});

import {
  assertWebhookUrlAllowed,
  directExternalFetch,
  _internal,
} from '../src/lib/external-egress-core';

const PUBLIC_V4 = { address: '93.184.216.34', family: 4 } as const;
const PUBLIC_V6 = { address: '2606:4700:4700::1111', family: 6 } as const;
const PRIVATE_METADATA = { address: '169.254.169.254', family: 4 } as const;

afterEach(() => {
  mocks.callbackLookup.mockReset();
  mocks.fetch.mockReset();
  mocks.promisesLookup.mockReset();
});

describe('assertWebhookUrlAllowed', () => {
  it('rejects non-https, localhost, .local, and private literals', async () => {
    await expect(assertWebhookUrlAllowed('http://93.184.216.34/hook')).rejects.toThrow(/https/);
    await expect(assertWebhookUrlAllowed('https://localhost/hook')).rejects.toThrow(/not public/);
    await expect(assertWebhookUrlAllowed('https://printer.local/hook')).rejects.toThrow(
      /not public/,
    );
    await expect(assertWebhookUrlAllowed('https://10.0.0.1/hook')).rejects.toThrow(/not public/);
    await expect(assertWebhookUrlAllowed('https://169.254.169.254/hook')).rejects.toThrow(
      /not public/,
    );
  });

  it('rejects any private DNS answer and accepts an all-public host', async () => {
    mocks.promisesLookup.mockResolvedValueOnce([PUBLIC_V4, PRIVATE_METADATA]);
    await expect(assertWebhookUrlAllowed('https://rebind.example/hook')).rejects.toThrow(
      /private address/,
    );

    mocks.promisesLookup.mockResolvedValueOnce([PUBLIC_V4, PUBLIC_V6]);
    await expect(assertWebhookUrlAllowed('https://hooks.example.com/x')).resolves.toBeUndefined();
  });
});

describe('direct custom webhook delivery', () => {
  it('refuses redirects and always supplies the SSRF-safe dispatcher', async () => {
    mocks.promisesLookup.mockResolvedValue([PUBLIC_V4]);
    mocks.fetch.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );

    await expect(
      directExternalFetch({
        target: 'custom_webhook',
        url: 'https://hooks.example.com/x',
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/redirect/);

    expect(mocks.promisesLookup).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0]?.[1]).toMatchObject({
      dispatcher: expect.anything(),
      redirect: 'manual',
    });
  });

  it('returns a successful public response', async () => {
    mocks.promisesLookup.mockResolvedValue([PUBLIC_V4]);
    mocks.fetch.mockResolvedValue(new Response('ok', { status: 200 }));
    await expect(
      directExternalFetch({
        target: 'custom_webhook',
        url: 'https://hooks.example.com/x',
        method: 'POST',
        body: '{}',
      }),
    ).resolves.toMatchObject({ status: 200, body: 'ok' });
  });
});

describe('ssrfSafeLookup callback contract', () => {
  it('returns one public address for scalar lookup', async () => {
    mocks.callbackLookup.mockImplementation((_host, _options, callback) =>
      callback(null, [PRIVATE_METADATA, PUBLIC_V4, PUBLIC_V6]),
    );

    const result = await new Promise<[unknown, string | LookupAddress[], number | undefined]>(
      (resolve) => {
        _internal.ssrfSafeLookup('mixed.example', {}, (error, address, family) =>
          resolve([error, address, family]),
        );
      },
    );

    expect(result).toEqual([null, PUBLIC_V4.address, PUBLIC_V4.family]);
    expect(mocks.callbackLookup.mock.calls[0]?.[1]).toMatchObject({ all: true, verbatim: true });
  });

  it('returns every public address as an array when all=true', async () => {
    mocks.callbackLookup.mockImplementation((_host, _options, callback) =>
      callback(null, [PRIVATE_METADATA, PUBLIC_V4, PUBLIC_V6]),
    );

    const result = await new Promise<[unknown, string | LookupAddress[]]>((resolve) => {
      _internal.ssrfSafeLookup(
        'mixed.example',
        { all: true } as LookupOptions,
        (error, addresses) => resolve([error, addresses]),
      );
    });

    expect(result).toEqual([null, [PUBLIC_V4, PUBLIC_V6]]);
  });

  it('uses scalar and array error shapes when all addresses are blocked', async () => {
    mocks.callbackLookup.mockImplementation((_host, _options, callback) =>
      callback(null, [PRIVATE_METADATA]),
    );

    const scalar = await new Promise<[NodeJS.ErrnoException | null, unknown, unknown]>(
      (resolve) => {
        _internal.ssrfSafeLookup('private.example', {}, (error, address, family) =>
          resolve([error, address, family]),
        );
      },
    );
    expect(scalar[0]?.code).toBe('EEGRESSBLOCKED');
    expect(scalar.slice(1)).toEqual(['', 0]);

    const all = await new Promise<[NodeJS.ErrnoException | null, unknown]>((resolve) => {
      _internal.ssrfSafeLookup(
        'private.example',
        { all: true } as LookupOptions,
        (error, addresses) => resolve([error, addresses]),
      );
    });
    expect(all[0]?.code).toBe('EEGRESSBLOCKED');
    expect(all[1]).toEqual([]);
  });

  it('preserves scalar and array shapes for resolver errors', async () => {
    const dnsError = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    mocks.callbackLookup.mockImplementation((_host, _options, callback) => callback(dnsError));

    const scalar = await new Promise<[NodeJS.ErrnoException | null, unknown, unknown]>(
      (resolve) => {
        _internal.ssrfSafeLookup('missing.example', {}, (error, address, family) =>
          resolve([error, address, family]),
        );
      },
    );
    expect(scalar).toEqual([dnsError, '', 0]);

    const all = await new Promise<[NodeJS.ErrnoException | null, unknown]>((resolve) => {
      _internal.ssrfSafeLookup(
        'missing.example',
        { all: true } as LookupOptions,
        (error, addresses) => resolve([error, addresses]),
      );
    });
    expect(all).toEqual([dnsError, []]);
  });
});

describe('private-address classification', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.2',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1',
    'fd00::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '64:ff9b::a00:1',
  ])('blocks %s', (address) => {
    expect(_internal.isPrivateIp(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('allows %s', (address) => {
    expect(_internal.isPrivateIp(address)).toBe(false);
  });
});
