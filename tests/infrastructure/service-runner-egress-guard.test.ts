import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createServiceRunnerFetch } from '../fixtures/service-runner-egress-guard.mjs';

interface LocalServer {
  origin: string;
  requests(): number;
  redirectTo(value: string | null): void;
  stop(): Promise<void>;
}

const servers = new Set<Server>();
const execFileAsync = promisify(execFile);

async function startServer(): Promise<LocalServer> {
  let count = 0;
  let redirect: string | null = null;
  const server = createServer((_request, response) => {
    count += 1;
    if (redirect !== null) {
      response.writeHead(302, { location: redirect }).end();
      return;
    }
    response.writeHead(204).end();
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    redirectTo: (value) => {
      redirect = value;
    },
    stop: async () => {
      servers.delete(server);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe('clean-artifact service runner egress guard', () => {
  it('declares the Python transport used by cross-runtime fixtures in the unit job', () => {
    const workflow = readFileSync(path.resolve('.github/workflows/ci-fast.yml'), 'utf8');
    const unitStart = workflow.indexOf('  ci-unit-js:');
    const unitEnd = workflow.indexOf('\n  ci-egress-runtime:', unitStart);
    expect(unitStart).toBeGreaterThanOrEqual(0);
    expect(unitEnd).toBeGreaterThan(unitStart);
    const unitJob = workflow.slice(unitStart, unitEnd);
    expect(unitJob).toContain('actions/setup-python@v6');
    expect(unitJob).toContain("python-version: '3.12'");
    expect(unitJob).toContain("'httpx==0.28.1'");
    expect(unitJob.indexOf("'httpx==0.28.1'")).toBeLessThan(unitJob.indexOf('pnpm test'));
  });

  it('installs the boundary and sentinel probe in all four packaged runners', () => {
    for (const fixture of [
      'authoritative-budget-sdk-ts-runner.mjs',
      'authoritative-budget-langgraph-sdk-ts-runner.mjs',
    ]) {
      const source = readFileSync(path.resolve('tests/fixtures', fixture), 'utf8');
      expect(source, fixture).toContain('createServiceRunnerFetch');
      expect(source, fixture).toContain('assertEgressSentinelBlocked');
    }
    for (const fixture of [
      'authoritative_budget_sdk_py_runner.py',
      'authoritative_budget_langgraph_sdk_py_runner.py',
    ]) {
      const source = readFileSync(path.resolve('tests/fixtures', fixture), 'utf8');
      expect(source, fixture).toContain('install_service_runner_egress_guard');
      expect(source, fixture).toContain('assert_egress_sentinel_blocked');
      const guardIndex = source.indexOf('install_service_runner_egress_guard(_ENDPOINT)');
      expect(guardIndex, fixture).toBeGreaterThanOrEqual(0);
      expect(guardIndex, fixture).toBeLessThan(source.indexOf('import pylva '));
      if (fixture.includes('langgraph')) {
        expect(guardIndex, fixture).toBeLessThan(source.indexOf('import openai '));
      }
    }
  });

  it('blocks import-time wheel HTTPX egress before the tested module loads', async () => {
    const backend = await startServer();
    const sentinel = await startServer();
    const python = process.env['PYLVA_CHAOS_PYTHON'] ?? 'python3';
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'pylva-import-egress-'));
    try {
      writeFileSync(
        path.join(fakeRoot, 'pylva.py'),
        [
          'import os',
          'import httpx',
          'httpx.get(os.environ["PYLVA_EGRESS_SENTINEL_URL"], timeout=0.25)',
          'raise AssertionError("import-time request unexpectedly returned")',
        ].join('\n'),
      );
      const metadata = path.join(fakeRoot, 'pylva_sdk-9.9.9.dist-info');
      mkdirSync(metadata);
      writeFileSync(path.join(metadata, 'METADATA'), 'Name: pylva-sdk\nVersion: 9.9.9\n');
      const wheel = path.join(fakeRoot, 'pylva_sdk-9.9.9-py3-none-any.whl');
      writeFileSync(wheel, 'immutable import-egress fixture');
      const wheelSha256 = crypto.createHash('sha256').update(readFileSync(wheel)).digest('hex');

      await expect(
        execFileAsync(
          python,
          [path.resolve('tests/fixtures/authoritative_budget_sdk_py_runner.py')],
          {
            env: {
              ...process.env,
              PYLVA_EGRESS_SENTINEL_URL: sentinel.origin,
              PYLVA_PYTHON_ARTIFACT_SOURCE_SHA: 'a'.repeat(40),
              PYLVA_PYTHON_ARTIFACT_VERSION: '9.9.9',
              PYLVA_PYTHON_WHEEL: wheel,
              PYLVA_PYTHON_WHEEL_SHA256: wheelSha256,
              PYLVA_RUNNER_API_KEY: `pv_live_12345678_${'a'.repeat(32)}`,
              PYLVA_RUNNER_COUNT: '0',
              PYLVA_RUNNER_ENDPOINT: backend.origin,
              PYLVA_RUNNER_MODE: 'legacy',
              PYTHONPATH: fakeRoot,
            },
          },
        ),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('unexpected external request:') });
      expect(backend.requests()).toBe(0);
      expect(sentinel.requests()).toBe(0);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it('allows exact method/path pairs and rejects lookalikes before native transport', async () => {
    const backend = await startServer();
    const sentinel = await startServer();
    let providerCalls = 0;
    const guardedFetch = createServiceRunnerFetch({
      endpoint: backend.origin,
      networkFetch: fetch,
      providerHandler: async () => {
        providerCalls += 1;
        return new Response('{}', { status: 200 });
      },
    });

    await expect(
      guardedFetch(`${backend.origin}/api/v1/budget/capabilities`),
    ).resolves.toHaveProperty('status', 204);
    expect(backend.requests()).toBe(1);

    for (const [url, method] of [
      [`${sentinel.origin}/api/v1/budget/capabilities`, 'GET'],
      [
        `${backend.origin}/api/v1/budget/capabilities?next=${encodeURIComponent(sentinel.origin)}`,
        'GET',
      ],
      [`${backend.origin}/api/v1/budget/capabilities-extra`, 'GET'],
      [`${backend.origin}/api/v1/budget/capabilities`, 'POST'],
      [backend.origin.replace('http://', 'https://') + '/api/v1/budget/capabilities', 'GET'],
      [backend.origin.replace('://', '://user:password@') + '/api/v1/budget/capabilities', 'GET'],
      ['https://api.openai.com/v1/chat/completions/extra', 'POST'],
      ['https://api.openai.com/v1/chat/completions?redirect=blocked', 'POST'],
      ['https://user:password@api.openai.com/v1/chat/completions', 'POST'],
    ] as const) {
      await expect(guardedFetch(url, { method })).rejects.toThrow('unexpected external request');
    }
    expect(backend.requests()).toBe(1);
    expect(sentinel.requests()).toBe(0);
    expect(providerCalls).toBe(0);

    await expect(
      guardedFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' }),
    ).resolves.toHaveProperty('status', 200);
    expect(providerCalls).toBe(1);
  });

  it('never follows an allowed-origin redirect to a blocked sentinel', async () => {
    const backend = await startServer();
    const sentinel = await startServer();
    backend.redirectTo(`${sentinel.origin}/credential-bearing-target`);
    const guardedFetch = createServiceRunnerFetch({
      endpoint: backend.origin,
      networkFetch: fetch,
    });

    await expect(guardedFetch(`${backend.origin}/api/v1/budget/capabilities`)).rejects.toThrow(
      'unexpected redirect from allowed service route',
    );
    expect(backend.requests()).toBe(1);
    expect(sentinel.requests()).toBe(0);
  });

  it('enforces the same native-transport boundary in packaged Python runners', async () => {
    const backend = await startServer();
    const sentinel = await startServer();
    const python = process.env['PYLVA_CHAOS_PYTHON'] ?? 'python3';
    const environment = {
      ...process.env,
      PYLVA_EGRESS_BACKEND: backend.origin,
      PYLVA_EGRESS_FIXTURES: path.resolve('tests/fixtures'),
      PYLVA_EGRESS_SENTINEL: sentinel.origin,
    };
    const common = [
      'import os, sys, httpx',
      'sys.path.insert(0, os.environ["PYLVA_EGRESS_FIXTURES"])',
      'from service_runner_egress_guard import assert_egress_sentinel_blocked, install_service_runner_egress_guard',
      'install_service_runner_egress_guard(os.environ["PYLVA_EGRESS_BACKEND"])',
      'assert_egress_sentinel_blocked(os.environ["PYLVA_EGRESS_SENTINEL"])',
    ];
    await execFileAsync(
      python,
      [
        '-c',
        [
          ...common,
          'assert httpx.get(os.environ["PYLVA_EGRESS_BACKEND"] + "/api/v1/budget/capabilities").status_code == 204',
        ].join('; '),
      ],
      { env: environment },
    );
    expect(backend.requests()).toBe(1);
    expect(sentinel.requests()).toBe(0);

    await execFileAsync(
      python,
      [
        '-c',
        [
          ...common,
          'blocked = [',
          '  os.environ["PYLVA_EGRESS_BACKEND"] + "/api/v1/budget/capabilities?query=blocked",',
          '  os.environ["PYLVA_EGRESS_BACKEND"] + "/api/v1/budget/capabilities-extra",',
          '  os.environ["PYLVA_EGRESS_BACKEND"].replace("://", "://user:password@") + "/api/v1/budget/capabilities",',
          '  os.environ["PYLVA_EGRESS_SENTINEL"] + "/api/v1/budget/capabilities",',
          '  "https://api.openai.com/v1/chat/completions/extra",',
          ']',
          'for url in blocked:',
          '  try: httpx.get(url)',
          '  except RuntimeError as error: assert str(error).startswith("unexpected external request:")',
          '  else: raise AssertionError("blocked URL reached native transport: " + url)',
        ].join('\n'),
      ],
      { env: environment },
    );
    expect(backend.requests()).toBe(1);
    expect(sentinel.requests()).toBe(0);

    backend.redirectTo(`${sentinel.origin}/blocked-redirect-target`);
    await expect(
      execFileAsync(
        python,
        [
          '-c',
          [
            ...common,
            'httpx.get(os.environ["PYLVA_EGRESS_BACKEND"] + "/api/v1/budget/capabilities")',
          ].join('; '),
        ],
        { env: environment },
      ),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('unexpected redirect') });
    expect(backend.requests()).toBe(2);
    expect(sentinel.requests()).toBe(0);
  });
});
