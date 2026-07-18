import crypto from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import argon2 from 'argon2';
import type { Sql, TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createBudgetControlCutover,
  markBudgetControlReady,
} from '../../src/lib/budget-control/readiness.js';
import { createBudgetLifecycleService } from '../../src/lib/budget-control/lifecycle-service.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const SERVER_FIXTURE = path.resolve('tests/fixtures/authoritative-budget-http-server.ts');
const TSX = path.resolve('node_modules/.bin/tsx');
const TS_SDK_RUNNER = path.resolve('tests/fixtures/authoritative-budget-sdk-ts-runner.mjs');
const PY_SDK_RUNNER = path.resolve('tests/fixtures/authoritative_budget_sdk_py_runner.py');
const SDK_HEADERS = {
  'content-type': 'application/json',
  'x-pylva-sdk-language': 'typescript',
  'x-pylva-sdk-version': '1.2.0-chaos',
};

type JsonObject = Record<string, unknown>;

interface ControlledBuilder {
  apiKey: string;
  builderId: string;
  ruleKeys: string[];
}

interface RuleSpec {
  limitUsd: string;
  period?: 'hour' | 'day';
  scope: 'per_customer' | 'pooled';
}

interface ChaosServer {
  child: ChildProcessWithoutNullStreams;
  endpoint: string;
  stderr: string[];
  stdout: string[];
  stop(): Promise<void>;
}

interface HttpResult {
  body: JsonObject;
  headers: Headers;
  status: number;
}

interface SdkRunner {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<JsonObject>;
  result: Promise<JsonObject>;
  stderr: string[];
  release(): void;
  stop(): Promise<void>;
}

let scratch: ScratchDb | undefined;
const runningServers = new Set<ChaosServer>();
const runningRunners = new Set<SdkRunner>();

function requiredArtifactEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`TypeScript artifact integration gate requires ${name}`);
  return value;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function assertTypescriptArtifactEvidence(result: JsonObject): void {
  expect(process.env['PYLVA_TYPESCRIPT_ARTIFACT_MODE']).toBe('immutable');
  const workspaceRoot = realpathSync(process.cwd());
  const installRoot = realpathSync(requiredArtifactEnvironment('PYLVA_TYPESCRIPT_INSTALL_ROOT'));
  const tarball = realpathSync(requiredArtifactEnvironment('PYLVA_TYPESCRIPT_TARBALL'));
  const expectedSha256 = requiredArtifactEnvironment('PYLVA_TYPESCRIPT_TARBALL_SHA256');
  const actualSha256 = crypto.createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const sdkArtifact = realpathSync(String(result['sdkArtifact']));
  const sdkPackageRoot = realpathSync(String(result['sdkPackageRoot']));
  const manifest = JSON.parse(readFileSync(path.join(sdkPackageRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };

  expect(actualSha256).toBe(expectedSha256);
  expect(result).toMatchObject({
    artifactMode: 'immutable',
    sdkArtifact: sdkArtifact,
    sdkArtifactSha256: expectedSha256,
    sdkInstallRoot: installRoot,
    sdkPackageRoot,
    sdkTarball: tarball,
    sdkVersion: manifest.version,
  });
  expect(isWithin(workspaceRoot, installRoot)).toBe(false);
  expect(isWithin(workspaceRoot, sdkArtifact)).toBe(false);
  expect(isWithin(installRoot, sdkArtifact)).toBe(true);
  expect(isWithin(installRoot, sdkPackageRoot)).toBe(true);
}

function db(): Sql {
  if (!scratch) throw new Error('chaos scratch database is unavailable');
  return scratch.sql;
}

async function withBuilder<T>(
  builderId: string,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await db().begin(async (tx) => {
    await tx`SELECT pg_catalog.set_config('app.builder_id', ${builderId}, true)`;
    return callback(tx);
  })) as T;
}

function childEnvironment(options: {
  oldBackend?: boolean;
  redisOutage?: boolean;
}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'true',
    ARGON2_SECRET: 'test-secret',
    CLICKHOUSE_URL: process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123',
    CRON_SECRET: '12345678901234567890123456789012',
    DATABASE_URL: scratch!.url,
    ENABLE_AUTHORITATIVE_BUDGET_CONTROL: 'true',
    JWT_PRIVATE_KEY: '/tmp/pylva-chaos-private.pem',
    JWT_PUBLIC_KEY: '/tmp/pylva-chaos-public.pem',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    PYLVA_CHAOS_OLD_BACKEND: options.oldBackend ? 'true' : 'false',
    REDIS_URL: options.redisOutage
      ? 'redis://127.0.0.1:1'
      : (process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'),
  };
  // This 051 scratch suite intentionally exercises the explicit local/CI
  // fallback. Never let workflow-level production/migration credentials
  // redirect a child away from its isolated scratch database.
  delete environment['BUDGET_CONTROL_DATABASE_URL'];
  delete environment['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN'];
  for (const name of Object.keys(environment)) {
    if (name === 'MIGRATION_DATABASE_URL' || name.startsWith('MIGRATION_DB_')) {
      delete environment[name];
    }
  }
  return environment;
}

async function startServer(
  options: { oldBackend?: boolean; redisOutage?: boolean } = {},
): Promise<ChaosServer> {
  const child = spawn(TSX, [SERVER_FIXTURE], {
    cwd: process.cwd(),
    env: childEnvironment(options),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(
      () => reject(new Error('chaos HTTP server did not become ready')),
      15_000,
    );
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      reject(new Error(`chaos HTTP server exited before readiness (${code ?? 'signal'})`));
    };
    child.once('exit', onExit);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout.push(chunk);
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const parsed = JSON.parse(line) as { port?: unknown; ready?: unknown };
          if (parsed.ready === true && typeof parsed.port === 'number') {
            clearTimeout(timeout);
            child.off('exit', onExit);
            resolve(parsed.port);
            return;
          }
        } catch {
          // Production logs may precede the machine-readable readiness line.
        }
      }
    });
  });

  let stopped = false;
  const result: ChaosServer = {
    child,
    endpoint: `http://127.0.0.1:${port}`,
    stderr,
    stdout,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      runningServers.delete(result);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([
        exited,
        new Promise<void>((resolve) =>
          setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 2_000),
        ),
      ]);
    },
  };
  runningServers.add(result);
  return result;
}

function runnerEnvironment(input: {
  apiKey: string;
  count: number;
  endpoint: string;
  mode: 'contend' | 'legacy' | 'old_backend';
  prefix: string;
  runtime: 'python' | 'typescript';
}): NodeJS.ProcessEnv {
  const pythonPath = process.env['PYLVA_CHAOS_PYTHONPATH'] ?? '';
  return {
    ...process.env,
    PYLVA_RUNNER_API_KEY: input.apiKey,
    PYLVA_RUNNER_COUNT: String(input.count),
    PYLVA_RUNNER_ENDPOINT: input.endpoint,
    PYLVA_RUNNER_MODE: input.mode,
    PYLVA_RUNNER_PREFIX: input.prefix,
    ...(input.runtime === 'python'
      ? {
          PYTHONDONTWRITEBYTECODE: '1',
          // Empty by default so the gate proves a wheel installed into the
          // selected interpreter. A source-tree override must be explicit.
          PYTHONPATH: pythonPath,
        }
      : {}),
  };
}

function startSdkRunner(input: {
  apiKey: string;
  count: number;
  endpoint: string;
  mode: 'contend' | 'legacy' | 'old_backend';
  prefix: string;
  runtime: 'python' | 'typescript';
}): SdkRunner {
  const command =
    input.runtime === 'typescript'
      ? process.execPath
      : (process.env['PYLVA_CHAOS_PYTHON'] ?? 'python3');
  const fixture = input.runtime === 'typescript' ? TS_SDK_RUNNER : PY_SDK_RUNNER;
  const child = spawn(command, [fixture], {
    cwd: process.cwd(),
    env: runnerEnvironment(input),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  let resolveReady!: (value: JsonObject) => void;
  let rejectReady!: (reason: Error) => void;
  const ready = new Promise<JsonObject>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveResult!: (value: JsonObject) => void;
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<JsonObject>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A legacy/unsupported runner intentionally exits without a ready event;
  // mark that promise handled so it cannot create an unhandled rejection.
  void ready.catch(() => undefined);
  void result.catch(() => undefined);

  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      try {
        const parsed = JSON.parse(line) as JsonObject;
        if (parsed['event'] === 'ready') resolveReady(parsed);
        if (parsed['event'] === 'result') resolveResult(parsed);
        if (parsed['event'] === 'error') {
          rejectResult(
            new Error(`SDK runner failed: ${String(parsed['name'])}: ${String(parsed['message'])}`),
          );
        }
      } catch {
        // Ignore non-machine-readable output from optional SDK dependencies.
      }
    }
  });

  let settled = false;
  let stopping = false;
  const runner: SdkRunner = {
    child,
    ready,
    result,
    stderr,
    release: () => child.stdin.write('\n'),
    stop: async () => {
      if (settled) return;
      stopping = true;
      settled = true;
      runningRunners.delete(runner);
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      timer.unref();
      await exited;
      clearTimeout(timer);
    },
  };
  runningRunners.add(runner);
  child.once('exit', (code) => {
    runningRunners.delete(runner);
    settled = true;
    if (code === 0 || stopping) return;
    const error = new Error(
      `SDK runner ${input.runtime} exited ${code ?? 'by signal'}: ${stderr.join('').slice(0, 500)}`,
    );
    rejectReady(error);
    rejectResult(error);
  });
  child.once('error', (error) => {
    rejectReady(error);
    rejectResult(error);
  });
  return runner;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function request(
  server: ChaosServer,
  apiKey: string,
  pathname: string,
  body?: JsonObject,
  options: { dropResponse?: boolean } = {},
): Promise<HttpResult> {
  const response = await fetch(`${server.endpoint}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...SDK_HEADERS,
      'x-pylva-key': apiKey,
      ...(options.dropResponse ? { 'x-pylva-chaos-drop-response': 'true' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return {
    body: text.length === 0 ? {} : (JSON.parse(text) as JsonObject),
    headers: response.headers,
    status: response.status,
  };
}

async function requestCounts(server: ChaosServer): Promise<Record<string, number>> {
  const response = await fetch(`${server.endpoint}/__chaos/stats`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`chaos stats request failed with ${response.status}`);
  const body = (await response.json()) as { requests?: unknown };
  if (body.requests === null || typeof body.requests !== 'object' || Array.isArray(body.requests)) {
    throw new Error('chaos stats response has no request map');
  }
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(body.requests)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('chaos stats response has an invalid request count');
    }
    counts[key] = value;
  }
  return counts;
}

function reserveRequest(customerId: string, operationId = crypto.randomUUID()): JsonObject {
  return {
    schema_version: '1.0',
    mode: 'enforce',
    operation_id: operationId,
    customer_id: customerId,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    step_name: 'chaos.tool',
    framework: 'none',
    reservation_ttl_seconds: 30,
    kind: 'tool',
    cost_source_slug: 'chaos-tool',
    tool_name: 'chaos_tool',
    metric: 'calls',
    maximum_value: '1',
  };
}

function commitRequest(): JsonObject {
  return {
    schema_version: '1.0',
    status: 'success',
    latency_ms: 1,
    stream_aborted: false,
    kind: 'tool',
    actual_value: '1',
  };
}

async function createControlledBuilder(rules: RuleSpec[]): Promise<ControlledBuilder> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [builder] = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`chaos-${suffix}@example.com`}, 'Chaos gate', 'pro', ${`chaos-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  const builderId = builder?.id;
  if (!builderId) throw new Error('chaos builder insert failed');

  await createBudgetControlCutover(builderId, 'next_period', { client: db(), maxAttempts: 1 });
  const readiness = await markBudgetControlReady(builderId, { client: db(), maxAttempts: 1 });
  if (!readiness.ready) throw new Error('chaos builder did not become ready');

  const ruleKeys = await withBuilder(builderId, async (tx) => {
    const inserted: string[] = [];
    for (const rule of rules) {
      const ruleKey = crypto.randomUUID();
      const snapshot = {
        schema_version: '1.0',
        rule_key: ruleKey,
        scope: rule.scope,
        target_customer_id: null,
        period: rule.period ?? 'day',
        enforcement: 'hard_stop',
        limit_usd: rule.limitUsd,
      };
      await tx`
        INSERT INTO public.budget_rule_revisions (
          builder_id, id, rule_key, revision, scope, target_customer_id,
          period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
        ) VALUES (
          ${builderId}::UUID, ${crypto.randomUUID()}::UUID, ${ruleKey}::UUID, 0,
          ${rule.scope}, NULL, ${rule.period ?? 'day'}, 'hard_stop',
          ${rule.limitUsd}::NUMERIC, ${tx.json(snapshot)}::JSONB,
          public.pylva_budget_jsonb_sha256(${tx.json(snapshot)}::JSONB)
        )
      `;
      inserted.push(ruleKey);
    }
    await tx`
      INSERT INTO public.cost_sources (
        builder_id, source_type, display_name, slug, metric, unit,
        price_per_unit, pricing_tiers, status, approved_at, tracking_status
      ) VALUES (
        ${builderId}::UUID, 'non_llm_manual', 'Chaos tool', 'chaos-tool',
        'calls', 'call', 0.1, NULL, 'healthy',
        pg_catalog.clock_timestamp(), 'tracked'
      )
    `;
    return inserted;
  });

  const keyId = crypto.randomBytes(4).toString('hex');
  const apiKey = `pv_live_${keyId}_${crypto.randomBytes(16).toString('hex')}`;
  const keyHash = await argon2.hash(apiKey, { secret: Buffer.from('test-secret') });
  await db()`
    INSERT INTO public.api_keys (key_id, builder_id, key_hash, scope, label)
    VALUES (${keyId}, ${builderId}::UUID, ${keyHash}, 'universal', 'chaos gate')
  `;
  return { apiKey, builderId, ruleKeys };
}

async function forceReservationExpired(builderId: string, reservationId: string): Promise<void> {
  await withBuilder(builderId, async (tx) => {
    await tx`ALTER TABLE public.budget_reservations DISABLE TRIGGER USER`;
    await tx`
      UPDATE public.budget_reservations
      SET created_at = '2020-01-01T00:00:00.000Z'::TIMESTAMPTZ,
          updated_at = '2020-01-01T00:00:00.000Z'::TIMESTAMPTZ,
          reserved_at = '2020-01-01T00:00:00.000Z'::TIMESTAMPTZ,
          expires_at = '2020-01-01T00:00:30.000Z'::TIMESTAMPTZ,
          reserve_response_snapshot = jsonb_set(
            reserve_response_snapshot,
            '{expires_at}',
            to_jsonb('2020-01-01T00:00:30.000Z'::TEXT)
          )
      WHERE builder_id = ${builderId}::UUID
        AND reservation_id = ${reservationId}::UUID
    `;
    await tx`ALTER TABLE public.budget_reservations ENABLE TRIGGER USER`;
  });
}

async function moveHeldAccountToPreviousHour(
  builderId: string,
  reservationId: string,
): Promise<void> {
  await withBuilder(builderId, async (tx) => {
    const [account] = await tx<{ id: string }[]>`
      SELECT allocation.account_id::TEXT AS id
      FROM public.budget_reservation_allocations allocation
      JOIN public.budget_reservations reservation
        ON reservation.builder_id = allocation.builder_id
       AND reservation.decision_id = allocation.reservation_decision_id
      WHERE reservation.builder_id = ${builderId}::UUID
        AND reservation.reservation_id = ${reservationId}::UUID
    `;
    if (!account?.id) throw new Error('held rollover account was not found');

    await tx`ALTER TABLE public.budget_accounts DISABLE TRIGGER USER`;
    await tx`ALTER TABLE public.budget_account_opening_evidence DISABLE TRIGGER USER`;
    await tx`
      WITH bounds AS (
        SELECT date_trunc('hour', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')
                 AT TIME ZONE 'UTC' - INTERVAL '1 hour' AS period_start
      ), candidate AS (
        SELECT account.id,
               bounds.period_start,
               bounds.period_start + INTERVAL '1 hour' AS period_end,
               jsonb_set(
                 jsonb_set(
                   account.initial_rule_snapshot,
                   '{period_start}',
                   to_jsonb(public.pylva_budget_timestamp_text(bounds.period_start))
                 ),
                 '{period_end}',
                 to_jsonb(public.pylva_budget_timestamp_text(bounds.period_start + INTERVAL '1 hour'))
               ) AS snapshot
        FROM public.budget_accounts account
        CROSS JOIN bounds
        WHERE account.builder_id = ${builderId}::UUID
          AND account.id = ${account.id}::UUID
      )
      UPDATE public.budget_accounts account
      SET period_start = candidate.period_start,
          period_end = candidate.period_end,
          initial_rule_snapshot = candidate.snapshot,
          initial_rule_snapshot_hash = public.pylva_budget_jsonb_sha256(candidate.snapshot)
      FROM candidate
      WHERE account.builder_id = ${builderId}::UUID
        AND account.id = candidate.id
    `;
    await tx`
      WITH account AS (
        SELECT period_start, period_end
        FROM public.budget_accounts
        WHERE builder_id = ${builderId}::UUID AND id = ${account.id}::UUID
      ), candidate AS (
        SELECT evidence.account_id,
               jsonb_set(
                 jsonb_set(
                   evidence.evidence_snapshot,
                   '{period_start}',
                   to_jsonb(public.pylva_budget_timestamp_text(account.period_start))
                 ),
                 '{period_end}',
                 to_jsonb(public.pylva_budget_timestamp_text(account.period_end))
               ) AS snapshot
        FROM public.budget_account_opening_evidence evidence
        CROSS JOIN account
        WHERE evidence.builder_id = ${builderId}::UUID
          AND evidence.account_id = ${account.id}::UUID
      )
      UPDATE public.budget_account_opening_evidence evidence
      SET evidence_snapshot = candidate.snapshot,
          evidence_snapshot_hash = public.pylva_budget_jsonb_sha256(candidate.snapshot)
      FROM candidate
      WHERE evidence.builder_id = ${builderId}::UUID
        AND evidence.account_id = candidate.account_id
    `;
    await tx`ALTER TABLE public.budget_account_opening_evidence ENABLE TRIGGER USER`;
    await tx`ALTER TABLE public.budget_accounts ENABLE TRIGGER USER`;
  });
}

function reservationId(result: HttpResult): string {
  const value = result.body['reservation_id'];
  if (typeof value !== 'string') throw new Error('response has no reservation_id');
  return value;
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'budget_chaos' });
  try {
    // Role-provisioning migration 052 is exercised by its privileged-role
    // integration suite; this general chaos database uses the ordinary test
    // login and applies the application-owned runtime schema through 051.
    await applyMigrationsThrough(scratch, '051');
  } catch (error) {
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
}, 60_000);

afterEach(async () => {
  await Promise.all([
    ...[...runningServers].map((server) => server.stop()),
    ...[...runningRunners].map((runner) => runner.stop()),
  ]);
});

afterAll(async () => {
  await Promise.all([
    ...[...runningServers].map((server) => server.stop()),
    ...[...runningRunners].map((runner) => runner.stop()),
  ]);
  await scratch?.drop();
  scratch = undefined;
});

describe('authoritative control real-service chaos and recovery', () => {
  it('linearizes real Python and TypeScript SDK processes against the same one-dollar account', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer();
    const typescript = startSdkRunner({
      apiKey: fixture.apiKey,
      count: 50,
      endpoint: server.endpoint,
      mode: 'contend',
      prefix: 'typescript',
      runtime: 'typescript',
    });
    const python = startSdkRunner({
      apiKey: fixture.apiKey,
      count: 50,
      endpoint: server.endpoint,
      mode: 'contend',
      prefix: 'python',
      runtime: 'python',
    });

    await Promise.all([
      withTimeout(typescript.ready, 180_000, 'TypeScript SDK readiness'),
      withTimeout(python.ready, 180_000, 'Python SDK readiness'),
    ]);
    const startedAt = performance.now();
    typescript.release();
    python.release();
    const [typescriptResult, pythonResult] = await Promise.all([
      withTimeout(typescript.result, 180_000, 'TypeScript SDK contention'),
      withTimeout(python.result, 180_000, 'Python SDK contention'),
    ]);
    const durationMs = performance.now() - startedAt;

    expect(typescriptResult).toMatchObject({
      event: 'result',
      runtime: 'typescript',
      decisions: { unavailable: 0 },
    });
    expect(pythonResult).toMatchObject({
      event: 'result',
      runtime: 'python',
      decisions: { unavailable: 0 },
    });
    const typescriptDecisions = typescriptResult['decisions'] as Record<string, number>;
    const pythonDecisions = pythonResult['decisions'] as Record<string, number>;
    const tsReserved = typescriptDecisions['reserved'] ?? -1;
    const tsDenied = typescriptDecisions['denied'] ?? -1;
    const tsUnavailable = typescriptDecisions['unavailable'] ?? -1;
    const pyReserved = pythonDecisions['reserved'] ?? -1;
    const pyDenied = pythonDecisions['denied'] ?? -1;
    const pyUnavailable = pythonDecisions['unavailable'] ?? -1;
    expect(tsReserved + tsDenied + tsUnavailable).toBe(50);
    expect(pyReserved + pyDenied + pyUnavailable).toBe(50);
    expect(tsReserved + pyReserved).toBe(10);
    expect(tsDenied + pyDenied).toBe(90);
    const reservedValues = [
      ...((typescriptResult['reservedUsd'] as unknown[]) ?? []),
      ...((pythonResult['reserved_usd'] as unknown[]) ?? []),
    ];
    expect(reservedValues.length).toBeGreaterThan(0);
    expect(new Set(reservedValues)).toEqual(new Set(['0.1']));
    assertTypescriptArtifactEvidence(typescriptResult);
    expect(String(pythonResult['sdk_path'])).toContain('/site-packages/pylva/__init__.py');

    const reservationIds = [
      ...((typescriptResult['reservationIds'] as unknown[]) ?? []),
      ...((pythonResult['reservation_ids'] as unknown[]) ?? []),
    ];
    expect(reservationIds).toHaveLength(10);
    expect(new Set(reservationIds).size).toBe(10);

    const [closure] = await withBuilder(
      fixture.builderId,
      (tx) => tx<
        {
          account_total: string;
          allocations: string;
          held_allocations: string;
          operations: string;
          reservations: string;
        }[]
      >`
        SELECT
          COUNT(DISTINCT reservation.operation_id)::TEXT AS operations,
          COUNT(DISTINCT reservation.decision_id)::TEXT AS reservations,
          COUNT(allocation.id)::TEXT AS allocations,
          COUNT(allocation.id) FILTER (WHERE allocation.held_at_reserve)::TEXT
            AS held_allocations,
          public.pylva_budget_decimal_text(MAX(
            account.committed_usd + account.reserved_usd + account.unresolved_usd
          )) AS account_total
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        WHERE reservation.builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(closure).toEqual({
      account_total: '1',
      allocations: '100',
      held_allocations: '10',
      operations: '100',
      reservations: '100',
    });
    const counts = await requestCounts(server);
    expect(counts).toMatchObject({
      'POST /api/v1/budget/reservations': 100,
    });
    const capabilityRequests = counts['GET /api/v1/budget/capabilities'] ?? 0;
    const boundedRefreshesPerRuntime = Math.ceil(durationMs / 30_000);
    expect(capabilityRequests).toBeGreaterThanOrEqual(2);
    expect(capabilityRequests).toBeLessThanOrEqual(2 + 2 * boundedRefreshesPerRuntime);
    expect(durationMs).toBeLessThan(120_000);
    console.info(
      '[budget-chaos] cross-runtime contention',
      JSON.stringify({
        duration_ms: Math.round(durationMs),
        python: pythonDecisions,
        typescript: typescriptDecisions,
      }),
    );
  }, 420_000);

  it('keeps legacy SDKs local against a new backend with zero control I/O', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer();
    const typescript = startSdkRunner({
      apiKey: fixture.apiKey,
      count: 0,
      endpoint: server.endpoint,
      mode: 'legacy',
      prefix: 'typescript_legacy',
      runtime: 'typescript',
    });
    const python = startSdkRunner({
      apiKey: fixture.apiKey,
      count: 0,
      endpoint: server.endpoint,
      mode: 'legacy',
      prefix: 'python_legacy',
      runtime: 'python',
    });
    const [typescriptResult, pythonResult] = await Promise.all([
      withTimeout(typescript.result, 180_000, 'TypeScript legacy SDK'),
      withTimeout(python.result, 180_000, 'Python legacy SDK'),
    ]);
    expect(typescriptResult).toMatchObject({
      decision: 'bypassed',
      event: 'result',
      local: true,
      ready: null,
      runtime: 'typescript',
    });
    expect(pythonResult).toMatchObject({
      decision: 'bypassed',
      event: 'result',
      ready: null,
      runtime: 'python',
    });
    assertTypescriptArtifactEvidence(typescriptResult);
    const counts = await requestCounts(server);
    expect(counts['GET /api/v1/budget/capabilities']).toBeUndefined();
    expect(counts['POST /api/v1/budget/reservations']).toBeUndefined();
    const [reservationCount] = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM public.budget_reservations
        WHERE builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(reservationCount?.count).toBe('0');
  }, 420_000);

  it('degrades new SDKs honestly when an old backend has no control routes', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer({ oldBackend: true });
    const typescript = startSdkRunner({
      apiKey: fixture.apiKey,
      count: 0,
      endpoint: server.endpoint,
      mode: 'old_backend',
      prefix: 'typescript_old_backend',
      runtime: 'typescript',
    });
    const python = startSdkRunner({
      apiKey: fixture.apiKey,
      count: 0,
      endpoint: server.endpoint,
      mode: 'old_backend',
      prefix: 'python_old_backend',
      runtime: 'python',
    });
    const [typescriptResult, pythonResult] = await Promise.all([
      withTimeout(typescript.result, 180_000, 'TypeScript old-backend compatibility'),
      withTimeout(python.result, 180_000, 'Python old-backend compatibility'),
    ]);
    expect(typescriptResult).toMatchObject({
      decision: 'unavailable',
      event: 'result',
      local: true,
      ready: false,
      runtime: 'typescript',
      supported: false,
    });
    expect(pythonResult).toMatchObject({
      decision: 'unavailable',
      event: 'result',
      ready: false,
      runtime: 'python',
    });
    assertTypescriptArtifactEvidence(typescriptResult);
    expect(await requestCounts(server)).toMatchObject({
      'GET /api/v1/budget/capabilities': 2,
    });
    const counts = await requestCounts(server);
    expect(counts['POST /api/v1/budget/reservations']).toBeUndefined();
    const [reservationCount] = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM public.budget_reservations
        WHERE builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(reservationCount?.count).toBe('0');
  }, 420_000);

  it('survives backend restarts and replays lost reserve and commit acknowledgements exactly once', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const operationId = crypto.randomUUID();
    const reserveBody = reserveRequest('restart_customer', operationId);
    const allLogs: string[] = [];

    let server = await startServer();
    const capabilities = await request(server, fixture.apiKey, '/api/v1/budget/capabilities');
    expect(capabilities).toMatchObject({ status: 200, body: { control_enabled: true } });
    await expect(
      request(server, fixture.apiKey, '/api/v1/budget/reservations', reserveBody, {
        dropResponse: true,
      }),
    ).rejects.toThrow();
    allLogs.push(...server.stdout, ...server.stderr);
    await server.stop();

    server = await startServer();
    const replayedReserve = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveBody,
    );
    if (replayedReserve.body['decision'] !== 'reserved') {
      throw new Error(
        `unexpected reserve response: ${JSON.stringify({
          body: replayedReserve.body,
          stderr: server.stderr,
        })}`,
      );
    }
    expect(replayedReserve).toMatchObject({
      status: 200,
      body: { decision: 'reserved', operation_id: operationId, reserved_usd: '0.1' },
    });
    const heldReservationId = reservationId(replayedReserve);
    await expect(
      request(
        server,
        fixture.apiKey,
        `/api/v1/budget/reservations/${heldReservationId}/commit`,
        commitRequest(),
        { dropResponse: true },
      ),
    ).rejects.toThrow();
    allLogs.push(...server.stdout, ...server.stderr);
    await server.stop();

    server = await startServer();
    const replayedCommit = await request(
      server,
      fixture.apiKey,
      `/api/v1/budget/reservations/${heldReservationId}/commit`,
      commitRequest(),
    );
    if (replayedCommit.status !== 200) {
      throw new Error(
        `unexpected commit response: ${JSON.stringify({
          body: replayedCommit.body,
          stderr: server.stderr,
        })}`,
      );
    }
    expect(replayedCommit).toMatchObject({
      status: 200,
      body: { state: 'committed', actual_usd: '0.1', idempotent_replay: true },
    });

    const [closure] = await withBuilder(
      fixture.builderId,
      (tx) => tx<
        {
          outbox_hash_valid: boolean;
          outbox_count: string;
          reservation_hashes_valid: boolean;
          reservation_count: string;
          transition_hash_valid: boolean;
          usage_hashes_valid: boolean;
          usage_count: string;
        }[]
      >`
        SELECT
          (SELECT COUNT(*)::TEXT FROM public.budget_reservations
           WHERE builder_id = ${fixture.builderId}::UUID) AS reservation_count,
          (SELECT COUNT(*)::TEXT FROM public.budget_usage_ledger
           WHERE builder_id = ${fixture.builderId}::UUID) AS usage_count,
          (SELECT COUNT(*)::TEXT FROM public.budget_cost_event_outbox
           WHERE builder_id = ${fixture.builderId}::UUID) AS outbox_count,
          (SELECT BOOL_AND(
             request_hash = public.pylva_budget_jsonb_sha256(request_snapshot)
             AND pricing_snapshot_hash = public.pylva_budget_jsonb_sha256(pricing_snapshot)
           ) FROM public.budget_reservations
           WHERE builder_id = ${fixture.builderId}::UUID) AS reservation_hashes_valid,
          (SELECT BOOL_AND(
             request_hash = public.pylva_budget_jsonb_sha256(request_snapshot)
           ) FROM public.budget_reservation_transitions
           WHERE builder_id = ${fixture.builderId}::UUID) AS transition_hash_valid,
          (SELECT BOOL_AND(
             pricing_snapshot_hash = public.pylva_budget_jsonb_sha256(pricing_snapshot)
             AND usage_snapshot_hash = public.pylva_budget_jsonb_sha256(usage_snapshot)
           ) FROM public.budget_usage_ledger
           WHERE builder_id = ${fixture.builderId}::UUID) AS usage_hashes_valid,
          (SELECT BOOL_AND(
             payload_hash = public.pylva_budget_jsonb_sha256(payload)
           ) FROM public.budget_cost_event_outbox
           WHERE builder_id = ${fixture.builderId}::UUID) AS outbox_hash_valid
      `,
    );
    expect(closure).toEqual({
      outbox_count: '1',
      outbox_hash_valid: true,
      reservation_count: '1',
      reservation_hashes_valid: true,
      transition_hash_valid: true,
      usage_count: '1',
      usage_hashes_valid: true,
    });
    allLogs.push(...server.stdout, ...server.stderr);
    const logs = allLogs.join('');
    expect(logs).not.toContain(fixture.apiKey);
    expect(logs).not.toContain(operationId);
    expect(logs).not.toContain('restart_customer');
  }, 120_000);

  it('keeps PostgreSQL authoritative during a Redis outage under 100-way contention', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer({ redisOutage: true });
    const startedAt = performance.now();
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        request(
          server,
          fixture.apiKey,
          '/api/v1/budget/reservations',
          reserveRequest(`redis_customer_${index.toString().padStart(3, '0')}`),
        ),
      ),
    );
    const durationMs = performance.now() - startedAt;
    const counts = responses.reduce<Record<string, number>>((result, response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const decision = String(response.body['decision']);
      result[decision] = (result[decision] ?? 0) + 1;
      return result;
    }, {});
    expect(counts).toEqual({ denied: 90, reserved: 10 });

    const [closure] = await withBuilder(
      fixture.builderId,
      (tx) => tx<
        { account_total: string; allocations: string; operations: string; reservations: string }[]
      >`
        SELECT
          COUNT(DISTINCT reservation.operation_id)::TEXT AS operations,
          COUNT(DISTINCT reservation.decision_id)::TEXT AS reservations,
          COUNT(allocation.id)::TEXT AS allocations,
          public.pylva_budget_decimal_text(MAX(
            account.committed_usd + account.reserved_usd + account.unresolved_usd
          )) AS account_total
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        WHERE reservation.builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(closure).toEqual({
      account_total: '1',
      allocations: '100',
      operations: '100',
      reservations: '100',
    });
    expect(durationMs).toBeLessThan(30_000);
    const logs = [...server.stdout, ...server.stderr].join('');
    expect(logs).not.toContain(fixture.apiKey);
    expect(logs).not.toContain('redis_customer_');
    console.info(
      '[budget-chaos] redis outage contention',
      JSON.stringify({
        denied: counts['denied'],
        duration_ms: Math.round(durationMs),
        reserved: 10,
      }),
    );
  }, 120_000);

  it('linearizes duplicate reserve races to one durable hold', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer();
    const operationId = crypto.randomUUID();
    const body = reserveRequest('duplicate_customer', operationId);
    const responses = await Promise.all(
      Array.from({ length: 32 }, () =>
        request(server, fixture.apiKey, '/api/v1/budget/reservations', body),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual(responses[0]?.body);
      expect(response.body).toMatchObject({
        decision: 'reserved',
        operation_id: operationId,
        reserved_usd: '0.1',
      });
    }
    expect(new Set(responses.map((response) => response.body['reservation_id'])).size).toBe(1);

    const [closure] = await withBuilder(
      fixture.builderId,
      (tx) => tx<
        {
          allocations: string;
          reservations: string;
          reserved_usd: string;
        }[]
      >`
        SELECT
          (SELECT COUNT(*)::TEXT FROM public.budget_reservations
           WHERE builder_id = ${fixture.builderId}::UUID) AS reservations,
          (SELECT COUNT(*)::TEXT FROM public.budget_reservation_allocations
           WHERE builder_id = ${fixture.builderId}::UUID) AS allocations,
          (SELECT public.pylva_budget_decimal_text(reserved_usd)
           FROM public.budget_accounts
           WHERE builder_id = ${fixture.builderId}::UUID) AS reserved_usd
      `,
    );
    expect(closure).toEqual({ allocations: '1', reservations: '1', reserved_usd: '0.1' });
  }, 120_000);

  it('allows exactly one winner in a real commit-versus-release race', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer();
    const reserved = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveRequest('terminal_race_customer'),
    );
    const heldId = reservationId(reserved);
    const [commit, release] = await Promise.all([
      request(
        server,
        fixture.apiKey,
        `/api/v1/budget/reservations/${heldId}/commit`,
        commitRequest(),
      ),
      request(server, fixture.apiKey, `/api/v1/budget/reservations/${heldId}/release`, {
        schema_version: '1.0',
        reason: 'provider_not_called',
      }),
    ]);
    expect([commit.status, release.status].sort((left, right) => left - right)).toEqual([200, 409]);

    const commitWon = commit.status === 200;
    const winner = commitWon ? commit : release;
    const loser = commitWon ? release : commit;
    expect(winner.body['state']).toBe(commitWon ? 'committed' : 'released');
    expect(loser.body).toMatchObject({ error: { code: 'RESERVATION_STATE_CONFLICT' } });

    const replay = commitWon
      ? await request(
          server,
          fixture.apiKey,
          `/api/v1/budget/reservations/${heldId}/commit`,
          commitRequest(),
        )
      : await request(server, fixture.apiKey, `/api/v1/budget/reservations/${heldId}/release`, {
          schema_version: '1.0',
          reason: 'provider_not_called',
        });
    expect(replay).toMatchObject({
      status: 200,
      body: { idempotent_replay: true, state: commitWon ? 'committed' : 'released' },
    });

    const [closure] = await withBuilder(
      fixture.builderId,
      (tx) => tx<
        {
          committed_usd: string;
          outbox_count: string;
          reserved_usd: string;
          state: string;
          transition_count: string;
          usage_count: string;
        }[]
      >`
        SELECT reservation.state,
               public.pylva_budget_decimal_text(account.committed_usd) AS committed_usd,
               public.pylva_budget_decimal_text(account.reserved_usd) AS reserved_usd,
               (SELECT COUNT(*)::TEXT FROM public.budget_reservation_transitions
                WHERE builder_id = ${fixture.builderId}::UUID) AS transition_count,
               (SELECT COUNT(*)::TEXT FROM public.budget_usage_ledger
                WHERE builder_id = ${fixture.builderId}::UUID) AS usage_count,
               (SELECT COUNT(*)::TEXT FROM public.budget_cost_event_outbox
                WHERE builder_id = ${fixture.builderId}::UUID) AS outbox_count
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = reservation.builder_id
         AND allocation.reservation_decision_id = reservation.decision_id
        JOIN public.budget_accounts account
          ON account.builder_id = allocation.builder_id AND account.id = allocation.account_id
        WHERE reservation.builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(closure).toEqual({
      committed_usd: commitWon ? '0.1' : '0',
      outbox_count: commitWon ? '1' : '0',
      reserved_usd: '0',
      state: commitWon ? 'committed' : 'released',
      transition_count: '1',
      usage_count: commitWon ? '1' : '0',
    });
  }, 120_000);

  it('extends once under duplicate HTTP retries, then releases idempotently', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer();
    const reserved = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveRequest('extend_customer'),
    );
    const heldId = reservationId(reserved);
    const originalExpiry = String(reserved.body['expires_at']);
    const extensionId = crypto.randomUUID();
    const extensionBody = {
      schema_version: '1.0',
      extension_id: extensionId,
      extend_by_seconds: 30,
    };
    const extensions = await Promise.all(
      Array.from({ length: 16 }, () =>
        request(
          server,
          fixture.apiKey,
          `/api/v1/budget/reservations/${heldId}/extend`,
          extensionBody,
        ),
      ),
    );
    for (const extension of extensions) {
      expect(extension).toMatchObject({
        status: 200,
        body: { state: 'reserved', extension_id: extensionId },
      });
      expect(extension.body['expires_at']).toBe(extensions[0]?.body['expires_at']);
    }
    expect(extensions.filter((result) => result.body['idempotent_replay'] === false)).toHaveLength(
      1,
    );
    expect(extensions.filter((result) => result.body['idempotent_replay'] === true)).toHaveLength(
      15,
    );
    expect(Date.parse(String(extensions[0]?.body['expires_at'])) - Date.parse(originalExpiry)).toBe(
      30_000,
    );

    const released = await request(
      server,
      fixture.apiKey,
      `/api/v1/budget/reservations/${heldId}/release`,
      { schema_version: '1.0', reason: 'provider_confirmed_uncharged' },
    );
    const replayedRelease = await request(
      server,
      fixture.apiKey,
      `/api/v1/budget/reservations/${heldId}/release`,
      { schema_version: '1.0', reason: 'provider_confirmed_uncharged' },
    );
    expect(released).toMatchObject({
      status: 200,
      body: { state: 'released', idempotent_replay: false },
    });
    expect(replayedRelease).toMatchObject({
      status: 200,
      body: { state: 'released', idempotent_replay: true },
    });

    const transitions = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ count: string; types: string[] }[]>`
        SELECT COUNT(*)::TEXT AS count, ARRAY_AGG(type ORDER BY occurred_at) AS types
        FROM public.budget_reservation_transitions
        WHERE builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(transitions).toEqual([{ count: '2', types: ['extend', 'release'] }]);
  }, 120_000);

  it('recovers process death before dispatch and after dispatch through expiry then late proof', async () => {
    const fixture = await createControlledBuilder([{ limitUsd: '10', scope: 'pooled' }]);
    let server = await startServer();
    const beforeDispatch = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveRequest('death_before_dispatch'),
    );
    const afterDispatch = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveRequest('death_after_dispatch'),
    );
    const beforeId = reservationId(beforeDispatch);
    const afterId = reservationId(afterDispatch);
    await server.stop();

    await forceReservationExpired(fixture.builderId, beforeId);
    await forceReservationExpired(fixture.builderId, afterId);
    const lifecycle = createBudgetLifecycleService({
      transactionOptions: { client: db(), maxAttempts: 1 },
    });
    await expect(lifecycle.expireDueBudgetReservations(fixture.builderId, 10)).resolves.toEqual({
      expired: 2,
    });

    server = await startServer();
    const released = await request(
      server,
      fixture.apiKey,
      `/api/v1/budget/reservations/${beforeId}/release`,
      { schema_version: '1.0', reason: 'provider_not_called' },
    );
    expect(released).toMatchObject({ status: 200, body: { state: 'released' } });
    const committed = await request(
      server,
      fixture.apiKey,
      `/api/v1/budget/reservations/${afterId}/commit`,
      commitRequest(),
    );
    expect(committed).toMatchObject({
      status: 200,
      body: { state: 'committed', late: true, actual_usd: '0.1' },
    });

    const rows = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ customer_id: string; state: string; transitions: string[] }[]>`
        SELECT reservation.customer_id, reservation.state,
               ARRAY_AGG(transition.type ORDER BY transition.from_state_version) AS transitions
        FROM public.budget_reservations reservation
        JOIN public.budget_reservation_transitions transition
          ON transition.builder_id = reservation.builder_id
         AND transition.reservation_decision_id = reservation.decision_id
        WHERE reservation.builder_id = ${fixture.builderId}::UUID
        GROUP BY reservation.customer_id, reservation.state
        ORDER BY reservation.customer_id
      `,
    );
    expect(rows).toEqual([
      {
        customer_id: 'death_after_dispatch',
        state: 'committed',
        transitions: ['expire_unresolved', 'commit'],
      },
      {
        customer_id: 'death_before_dispatch',
        state: 'released',
        transitions: ['expire_unresolved', 'release'],
      },
    ]);
  }, 120_000);

  it('keeps overlapping rules atomic and per-customer accounts isolated across tenants', async () => {
    const fixture = await createControlledBuilder([
      { limitUsd: '1', scope: 'pooled' },
      { limitUsd: '0.2', scope: 'per_customer' },
    ]);
    const foreign = await createControlledBuilder([{ limitUsd: '1', scope: 'pooled' }]);
    const server = await startServer();
    const reserveFor = (customerId: string) =>
      request(server, fixture.apiKey, '/api/v1/budget/reservations', reserveRequest(customerId));
    expect((await reserveFor('customer_a')).body['decision']).toBe('reserved');
    expect((await reserveFor('customer_a')).body['decision']).toBe('reserved');
    const denied = await reserveFor('customer_a');
    expect(denied.body['decision']).toBe('denied');
    const customerB = await reserveFor('customer_b');
    expect(customerB.body['decision']).toBe('reserved');

    const accounts = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ reserved: string; scope: string; subject_customer_id: string | null }[]>`
        SELECT account.scope, account.subject_customer_id,
               public.pylva_budget_decimal_text(account.reserved_usd) AS reserved
        FROM public.budget_accounts account
        WHERE account.builder_id = ${fixture.builderId}::UUID
        ORDER BY account.scope DESC, account.subject_customer_id NULLS FIRST
      `,
    );
    expect(accounts).toEqual([
      { scope: 'pooled', subject_customer_id: null, reserved: '0.3' },
      { scope: 'per_customer', subject_customer_id: 'customer_a', reserved: '0.2' },
      { scope: 'per_customer', subject_customer_id: 'customer_b', reserved: '0.1' },
    ]);

    const [deniedClosure] = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ allocations: string; held: string }[]>`
        SELECT COUNT(*)::TEXT AS allocations,
               COUNT(*) FILTER (WHERE held_at_reserve)::TEXT AS held
        FROM public.budget_reservation_allocations allocation
        JOIN public.budget_reservations reservation
          ON reservation.builder_id = allocation.builder_id
         AND reservation.decision_id = allocation.reservation_decision_id
        WHERE reservation.builder_id = ${fixture.builderId}::UUID
          AND reservation.operation_id = ${denied.body['operation_id'] as string}::UUID
      `,
    );
    expect(deniedClosure).toEqual({ allocations: '2', held: '0' });

    const foreignRead = await withBuilder(
      foreign.builderId,
      (tx) => tx<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM public.budget_reservations
        WHERE builder_id = ${fixture.builderId}::UUID
      `,
    );
    expect(foreignRead[0]?.count).toBe('0');
    const foreignCommit = await request(
      server,
      foreign.apiKey,
      `/api/v1/budget/reservations/${reservationId(customerB)}/commit`,
      commitRequest(),
    );
    expect(foreignCommit).toMatchObject({
      status: 404,
      body: { error: { code: 'RESOURCE_NOT_FOUND' } },
    });
    expect(JSON.stringify(foreignCommit.body)).not.toContain(fixture.builderId);
  }, 120_000);

  it('opens a new hourly account at rollover while a prior-period hold remains live', async () => {
    const fixture = await createControlledBuilder([
      { limitUsd: '1', period: 'hour', scope: 'pooled' },
    ]);
    let server = await startServer();
    const oldPeriod = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveRequest('rollover_customer'),
    );
    const oldReservationId = reservationId(oldPeriod);
    await server.stop();

    // Deterministic test-harness time travel: retain the complete immutable
    // account/evidence snapshot while moving that held account one UTC hour
    // back. Production source has no clock override or weakened trigger.
    await moveHeldAccountToPreviousHour(fixture.builderId, oldReservationId);
    server = await startServer();
    const currentPeriod = await request(
      server,
      fixture.apiKey,
      '/api/v1/budget/reservations',
      reserveRequest('rollover_customer'),
    );
    expect(currentPeriod.body['decision']).toBe('reserved');

    const rows = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ period_start: string; reservations: string; reserved: string }[]>`
        SELECT public.pylva_budget_timestamp_text(account.period_start) AS period_start,
               public.pylva_budget_decimal_text(account.reserved_usd) AS reserved,
               COUNT(allocation.id)::TEXT AS reservations
        FROM public.budget_accounts account
        LEFT JOIN public.budget_reservation_allocations allocation
          ON allocation.builder_id = account.builder_id AND allocation.account_id = account.id
        WHERE account.builder_id = ${fixture.builderId}::UUID
        GROUP BY account.id, account.period_start, account.reserved_usd
        ORDER BY account.period_start
      `,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.reserved)).toEqual(['0.1', '0.1']);
    expect(rows.map((row) => row.reservations)).toEqual(['1', '1']);
    expect(Date.parse(rows[1]!.period_start) - Date.parse(rows[0]!.period_start)).toBe(3_600_000);

    await withBuilder(fixture.builderId, async (tx) => {
      await tx`
        SELECT public.pylva_budget_assert_reservation_allocations(
          ${fixture.builderId}::UUID,
          decision_id,
          FALSE
        )
        FROM public.budget_reservations
        WHERE builder_id = ${fixture.builderId}::UUID
      `;
    });
  }, 120_000);
});
