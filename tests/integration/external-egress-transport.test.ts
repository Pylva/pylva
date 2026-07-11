import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import { createSsrfSafeLookup } from '../../src/lib/external-egress-core.js';

let server: Server;
let port: number;
let requestCount = 0;

beforeAll(async () => {
  server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('socket-ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function nestedCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

describe('Undici connect-time DNS integration', () => {
  it('returns an address array for all=true and completes a real socket request', async () => {
    const lookupOptions: LookupAllOptions[] = [];
    const lookup = createSsrfSafeLookup({
      isBlocked: () => false,
      lookupAll: (_hostname, options, callback) => {
        lookupOptions.push(options);
        const addresses: LookupAddress[] = [{ address: '127.0.0.1', family: 4 }];
        callback(null, addresses);
      },
    });
    const agent = new Agent({ connect: { lookup } });

    try {
      const response = await undiciFetch(`http://oauth-transport.test:${port}/token`, {
        dispatcher: agent,
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('socket-ok');
      expect(lookupOptions).toHaveLength(1);
      expect(lookupOptions[0]).toMatchObject({ all: true, verbatim: true });
    } finally {
      await agent.close();
    }
  });

  it('blocks a private connect-time answer before a socket is opened', async () => {
    const before = requestCount;
    const lookup = createSsrfSafeLookup({
      lookupAll: (_hostname, _options, callback) =>
        callback(null, [{ address: '127.0.0.1', family: 4 }]),
    });
    const agent = new Agent({ connect: { lookup } });

    try {
      const error = await undiciFetch(`http://blocked-transport.test:${port}/token`, {
        dispatcher: agent,
      }).catch((caught: unknown) => caught);
      expect(nestedCode(error)).toBe('EEGRESSBLOCKED');
      expect(requestCount).toBe(before);
    } finally {
      await agent.close();
    }
  });
});
