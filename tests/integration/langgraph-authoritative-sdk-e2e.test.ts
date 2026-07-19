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
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';
import { startEgressSentinel, type EgressSentinel } from '../helpers/egress-sentinel.js';
import { assertPythonSdkArtifactEvidence } from '../helpers/python-sdk-artifact-evidence.js';

const SERVER_FIXTURE = path.resolve('tests/fixtures/authoritative-budget-http-server.ts');
const TS_RUNNER = path.resolve('tests/fixtures/authoritative-budget-langgraph-sdk-ts-runner.mjs');
const PY_RUNNER = path.resolve('tests/fixtures/authoritative_budget_langgraph_sdk_py_runner.py');
const TSX = path.resolve('node_modules/.bin/tsx');
const MODEL = 'gpt-langgraph-e2e';
const TOOL_SLUG = 'langgraph-e2e-tool';
const LIMIT_USD = '0.101';

type Runtime = 'python' | 'typescript';
type JsonObject = Record<string, unknown>;

interface BuilderFixture {
  apiKey: string;
  builderId: string;
  customerId: string;
  ruleKey: string;
}

interface HarnessServer {
  child: ChildProcessWithoutNullStreams;
  endpoint: string;
  stderr: string[];
  stop(): Promise<void>;
}

interface RunnerProcess {
  child: ChildProcessWithoutNullStreams;
  stop(): Promise<void>;
}

interface ControlledIdentity {
  operation_id: string;
  reservation_id: string;
}

interface RefusalIdentity {
  kind: 'llm' | 'tool';
  operation_id: string;
  decision_id: string;
  rule_id: string;
  provider_calls_after: number;
  tool_calls_after: number;
}

interface JourneyResult extends JsonObject {
  event: 'result';
  runtime: Runtime;
  customer_id: string;
  trace_id: string;
  provider_calls: number;
  tool_calls: number;
  telemetry_before_refusal: number;
  telemetry_after_refusal: number;
  allowed_llm: ControlledIdentity;
  allowed_tool: ControlledIdentity;
  refusal: RefusalIdentity;
}

interface ReservationClosure {
  operation_id: string;
  decision_id: string;
  reservation_id: string | null;
  customer_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  request_trace_id: string | null;
  request_span_id: string | null;
  request_parent_span_id: string | null;
  step_name: string | null;
  framework: string;
  kind: 'llm' | 'tool';
  decision: string;
  state: string | null;
  requested_usd: string | null;
  reserved_usd: string;
  actual_usd: string;
  released_usd: string;
  remaining_usd: string | null;
  deciding_rule_key: string | null;
  usage_operation_id: string | null;
  usage_decision_id: string | null;
  usage_trace_id: string | null;
  usage_span_id: string | null;
  usage_parent_span_id: string | null;
  usage_kind: 'llm' | 'tool' | null;
  usage_cost_usd: string | null;
  actual_input_tokens: string | null;
  actual_output_tokens: string | null;
  actual_value: string | null;
  sdk_language: string | null;
  sdk_version: string | null;
  outbox_count: string;
  outbox_trace_id: string | null;
  outbox_span_id: string | null;
  outbox_parent_span_id: string | null;
}

let scratch: ScratchDb | undefined;
const servers = new Set<HarnessServer>();
const runners = new Set<RunnerProcess>();
const sentinels = new Set<EgressSentinel>();

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

function assertTypescriptArtifactEvidence(result: JourneyResult): void {
  expect(process.env['PYLVA_TYPESCRIPT_ARTIFACT_MODE']).toBe('immutable');
  const workspaceRoot = realpathSync(process.cwd());
  const installRoot = realpathSync(requiredArtifactEnvironment('PYLVA_TYPESCRIPT_INSTALL_ROOT'));
  const tarball = realpathSync(requiredArtifactEnvironment('PYLVA_TYPESCRIPT_TARBALL'));
  const expectedSha256 = requiredArtifactEnvironment('PYLVA_TYPESCRIPT_TARBALL_SHA256');
  const actualSha256 = crypto.createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const sdkArtifact = realpathSync(String(result['sdkArtifact']));
  const sdkLanggraphArtifact = realpathSync(String(result['sdkLanggraphArtifact']));
  const sdkOpenAiArtifact = realpathSync(String(result['sdkOpenAiArtifact']));
  const sdkPackageRoot = realpathSync(String(result['sdkPackageRoot']));
  const peerArtifacts = result['sdkPeerArtifacts'] as Record<string, unknown>;
  const peerPaths = Object.values(peerArtifacts).map((value) => realpathSync(String(value)));
  const manifest = JSON.parse(readFileSync(path.join(sdkPackageRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };

  expect(actualSha256).toBe(expectedSha256);
  expect(result).toMatchObject({
    artifactMode: 'immutable',
    sdkArtifact,
    sdkArtifactSha256: expectedSha256,
    sdkInstallRoot: installRoot,
    sdkLanggraphArtifact,
    sdkOpenAiArtifact,
    sdkPackageRoot,
    sdkTarball: tarball,
    sdkVersion: manifest.version,
  });
  expect(Object.keys(peerArtifacts).sort()).toEqual([
    'corePackageRoot',
    'langgraph',
    'langgraphPackageRoot',
    'messages',
    'testing',
    'tools',
  ]);
  expect(isWithin(workspaceRoot, installRoot)).toBe(false);
  for (const artifact of [
    sdkArtifact,
    sdkLanggraphArtifact,
    sdkOpenAiArtifact,
    sdkPackageRoot,
    ...peerPaths,
  ]) {
    expect(isWithin(workspaceRoot, artifact), artifact).toBe(false);
    expect(isWithin(installRoot, artifact), artifact).toBe(true);
  }
}

function db(): Sql {
  if (!scratch) throw new Error('LangGraph scratch database is unavailable');
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

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'true',
    ARGON2_SECRET: 'test-secret',
    CLICKHOUSE_URL: process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123',
    CRON_SECRET: '12345678901234567890123456789012',
    DATABASE_URL: scratch!.url,
    ENABLE_AUTHORITATIVE_BUDGET_CONTROL: 'true',
    JWT_PRIVATE_KEY: '/tmp/pylva-langgraph-private.pem',
    JWT_PUBLIC_KEY: '/tmp/pylva-langgraph-public.pem',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
  };
  delete environment['BUDGET_CONTROL_DATABASE_URL'];
  delete environment['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN'];
  for (const name of Object.keys(environment)) {
    if (name === 'MIGRATION_DATABASE_URL' || name.startsWith('MIGRATION_DB_')) {
      delete environment[name];
    }
  }
  return environment;
}

async function startServer(): Promise<HarnessServer> {
  const child = spawn(TSX, [SERVER_FIXTURE], {
    cwd: process.cwd(),
    env: childEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));

  const port = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    const timeout = setTimeout(
      () => reject(new Error('LangGraph HTTP fixture did not become ready')),
      15_000,
    );
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      reject(new Error(`LangGraph HTTP fixture exited before readiness (${code ?? 'signal'})`));
    };
    child.once('exit', onExit);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const value = JSON.parse(line) as { port?: unknown; ready?: unknown };
          if (value.ready === true && typeof value.port === 'number') {
            clearTimeout(timeout);
            child.off('exit', onExit);
            resolve(value.port);
            return;
          }
        } catch {
          // Framework logs can precede the machine-readable readiness line.
        }
      }
    });
  });

  let stopped = false;
  const server: HarnessServer = {
    child,
    endpoint: `http://127.0.0.1:${port}`,
    stderr,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      servers.delete(server);
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
  servers.add(server);
  return server;
}

function runnerEnvironment(
  runtime: Runtime,
  fixture: BuilderFixture,
  endpoint: string,
  egressSentinel?: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYLVA_LANGGRAPH_API_KEY: fixture.apiKey,
    PYLVA_LANGGRAPH_CUSTOMER_ID: fixture.customerId,
    PYLVA_LANGGRAPH_ENDPOINT: endpoint,
    PYLVA_LANGGRAPH_REFUSAL_KIND: runtime === 'typescript' ? 'llm' : 'tool',
    ...(egressSentinel ? { PYLVA_EGRESS_SENTINEL_URL: egressSentinel } : {}),
    ...(runtime === 'python'
      ? {
          PYTHONDONTWRITEBYTECODE: '1',
          // The service gate must prove the installed wheel, never this checkout.
          PYTHONPATH: '',
        }
      : {}),
  };
}

async function runJourney(
  runtime: Runtime,
  fixture: BuilderFixture,
  endpoint: string,
  egressSentinel?: string,
): Promise<JourneyResult> {
  const command =
    runtime === 'typescript'
      ? process.execPath
      : (process.env['PYLVA_LANGGRAPH_PYTHON'] ?? 'python3');
  const script = runtime === 'typescript' ? TS_RUNNER : PY_RUNNER;
  const child = spawn(command, [script], {
    cwd: process.cwd(),
    env: runnerEnvironment(runtime, fixture, endpoint, egressSentinel),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const processHandle: RunnerProcess = {
    child,
    stop: async () => {
      runners.delete(processHandle);
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
  runners.add(processHandle);

  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const outcome = await Promise.race([
    exit,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${runtime} LangGraph runner timed out`)), 120_000),
    ),
  ]).finally(() => runners.delete(processHandle));

  const records = stdout
    .join('')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonObject];
      } catch {
        return [];
      }
    });
  const result = records.find((record) => record['event'] === 'result');
  if (outcome.code !== 0 || !result) {
    const reported = records.find((record) => record['event'] === 'error');
    const stderrText = stderr.join('');
    const diagnostic =
      stderrText.length <= 6_000
        ? stderrText
        : `${stderrText.slice(0, 2_000)}\n...[stderr truncated]...\n${stderrText.slice(-4_000)}`;
    throw new Error(
      `${runtime} LangGraph runner failed (${outcome.code ?? outcome.signal ?? 'unknown'}): ` +
        `${JSON.stringify(reported ?? {})} ${diagnostic}`,
    );
  }
  return result as JourneyResult;
}

async function requestCounts(server: HarnessServer): Promise<Record<string, number>> {
  const response = await fetch(`${server.endpoint}/__chaos/stats`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`LangGraph stats request failed with ${response.status}`);
  const body = (await response.json()) as { requests?: unknown };
  if (body.requests === null || typeof body.requests !== 'object' || Array.isArray(body.requests)) {
    throw new Error('LangGraph stats response has no request map');
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(body.requests)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('LangGraph stats response has an invalid request count');
    }
    result[key] = value;
  }
  return result;
}

async function createControlledBuilder(runtime: Runtime): Promise<BuilderFixture> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [builder] = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`langgraph-${runtime}-${suffix}@example.com`},
      'LangGraph SDK gate',
      'pro',
      ${`langgraph-${runtime}-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  if (!builder?.id) throw new Error('LangGraph builder insert failed');
  const builderId = builder.id;

  await createBudgetControlCutover(builderId, 'next_period', { client: db(), maxAttempts: 1 });
  const readiness = await markBudgetControlReady(builderId, { client: db(), maxAttempts: 1 });
  if (!readiness.ready) throw new Error('LangGraph builder did not become ready');

  const ruleKey = crypto.randomUUID();
  await withBuilder(builderId, async (tx) => {
    const snapshot = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'hard_stop',
      limit_usd: LIMIT_USD,
    };
    await tx`
      INSERT INTO public.budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      ) VALUES (
        ${builderId}::UUID, ${crypto.randomUUID()}::UUID, ${ruleKey}::UUID, 0,
        'pooled', NULL, 'day', 'hard_stop', ${LIMIT_USD}::NUMERIC,
        ${tx.json(snapshot)}::JSONB,
        public.pylva_budget_jsonb_sha256(${tx.json(snapshot)}::JSONB)
      )
    `;
    await tx`
      INSERT INTO public.custom_pricing (
        builder_id, provider, model, price_per_unit_usd,
        input_per_1m_usd, output_per_1m_usd, effective_from, source
      ) VALUES (
        ${builderId}::UUID, 'openai', ${MODEL}, 0,
        100, 100, NOW() - INTERVAL '1 hour', 'builder_manual'
      )
    `;
    await tx`
      INSERT INTO public.cost_sources (
        builder_id, source_type, display_name, slug, metric, unit,
        price_per_unit, pricing_tiers, status, approved_at, tracking_status
      ) VALUES (
        ${builderId}::UUID, 'non_llm_manual', 'LangGraph E2E tool', ${TOOL_SLUG},
        'calls', 'call', 0.1, NULL, 'healthy', pg_catalog.clock_timestamp(), 'tracked'
      )
    `;
  });

  const keyId = crypto.randomBytes(4).toString('hex');
  const apiKey = `pv_live_${keyId}_${crypto.randomBytes(16).toString('hex')}`;
  const keyHash = await argon2.hash(apiKey, { secret: Buffer.from('test-secret') });
  await db()`
    INSERT INTO public.api_keys (key_id, builder_id, key_hash, scope, label)
    VALUES (${keyId}, ${builderId}::UUID, ${keyHash}, 'universal', 'LangGraph SDK gate')
  `;
  return {
    apiKey,
    builderId,
    customerId: `langgraph_${runtime}_${suffix}`,
    ruleKey,
  };
}

function assertRunnerResult(
  runtime: Runtime,
  fixture: BuilderFixture,
  result: JourneyResult,
): void {
  expect(result).toMatchObject({
    event: 'result',
    runtime,
    customer_id: fixture.customerId,
    provider_calls: 1,
    tool_calls: 1,
    telemetry_before_refusal: 0,
    telemetry_after_refusal: 0,
    refusal: {
      kind: runtime === 'typescript' ? 'llm' : 'tool',
      rule_id: fixture.ruleKey,
      provider_calls_after: 1,
      tool_calls_after: 1,
    },
  });
  expect(result.trace_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.allowed_llm.operation_id).not.toBe(result.allowed_tool.operation_id);
  expect(result.refusal.operation_id).not.toBe(result.allowed_llm.operation_id);
  expect(result.refusal.operation_id).not.toBe(result.allowed_tool.operation_id);
  if (runtime === 'typescript') {
    assertTypescriptArtifactEvidence(result);
    expect(result['identity_reinit_probe']).toBe(true);
  } else {
    assertPythonSdkArtifactEvidence(result);
    expect(String(result['sdk_path'])).toContain('/site-packages/pylva/__init__.py');
    expect(result['sdk_version']).toBe('1.2.0');
    expect(String(result['openai_path'])).toContain('/site-packages/openai/__init__.py');
    expect(result['openai_version']).toBe('2.45.0');
  }
}

async function assertBackendClosure(
  runtime: Runtime,
  fixture: BuilderFixture,
  result: JourneyResult,
): Promise<void> {
  const rows = await withBuilder(
    fixture.builderId,
    (tx) => tx<ReservationClosure[]>`
      SELECT
        reservation.operation_id::TEXT AS operation_id,
        reservation.decision_id::TEXT AS decision_id,
        reservation.reservation_id::TEXT AS reservation_id,
        reservation.customer_id,
        reservation.trace_id::TEXT AS trace_id,
        reservation.span_id::TEXT AS span_id,
        reservation.parent_span_id::TEXT AS parent_span_id,
        reservation.request_snapshot->>'trace_id' AS request_trace_id,
        reservation.request_snapshot->>'span_id' AS request_span_id,
        reservation.request_snapshot->>'parent_span_id' AS request_parent_span_id,
        reservation.step_name,
        reservation.framework,
        reservation.kind,
        reservation.decision,
        reservation.state,
        CASE WHEN reservation.requested_usd IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(reservation.requested_usd) END AS requested_usd,
        public.pylva_budget_decimal_text(reservation.reserved_usd) AS reserved_usd,
        public.pylva_budget_decimal_text(reservation.actual_usd) AS actual_usd,
        public.pylva_budget_decimal_text(reservation.released_usd) AS released_usd,
        CASE WHEN reservation.remaining_usd IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(reservation.remaining_usd) END AS remaining_usd,
        allocation.rule_key::TEXT AS deciding_rule_key,
        usage.operation_id::TEXT AS usage_operation_id,
        usage.reservation_decision_id::TEXT AS usage_decision_id,
        usage.trace_id::TEXT AS usage_trace_id,
        usage.span_id::TEXT AS usage_span_id,
        usage.parent_span_id::TEXT AS usage_parent_span_id,
        usage.kind AS usage_kind,
        CASE WHEN usage.actual_cost_usd IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(usage.actual_cost_usd) END AS usage_cost_usd,
        usage.actual_input_tokens::TEXT AS actual_input_tokens,
        usage.actual_output_tokens::TEXT AS actual_output_tokens,
        CASE WHEN usage.actual_value IS NULL THEN NULL
          ELSE public.pylva_budget_decimal_text(usage.actual_value) END AS actual_value,
        usage.sdk_language,
        usage.sdk_version,
        (
          SELECT COUNT(*)::TEXT
          FROM public.budget_cost_event_outbox outbox
          WHERE outbox.builder_id = usage.builder_id
            AND outbox.usage_ledger_id = usage.id
        ) AS outbox_count,
        (
          SELECT outbox.payload->>'trace_id'
          FROM public.budget_cost_event_outbox outbox
          WHERE outbox.builder_id = usage.builder_id
            AND outbox.usage_ledger_id = usage.id
        ) AS outbox_trace_id,
        (
          SELECT outbox.payload->>'span_id'
          FROM public.budget_cost_event_outbox outbox
          WHERE outbox.builder_id = usage.builder_id
            AND outbox.usage_ledger_id = usage.id
        ) AS outbox_span_id,
        (
          SELECT outbox.payload->>'parent_span_id'
          FROM public.budget_cost_event_outbox outbox
          WHERE outbox.builder_id = usage.builder_id
            AND outbox.usage_ledger_id = usage.id
        ) AS outbox_parent_span_id
      FROM public.budget_reservations reservation
      LEFT JOIN public.budget_reservation_allocations allocation
        ON allocation.builder_id = reservation.builder_id
       AND allocation.reservation_decision_id = reservation.decision_id
       AND allocation.is_deciding
      LEFT JOIN public.budget_usage_ledger usage
        ON usage.builder_id = reservation.builder_id
       AND usage.operation_id = reservation.operation_id
      WHERE reservation.builder_id = ${fixture.builderId}::UUID
      ORDER BY reservation.created_at, reservation.operation_id
    `,
  );
  expect(rows).toHaveLength(3);
  const byOperation = new Map(rows.map((row) => [row.operation_id, row]));
  const llm = byOperation.get(result.allowed_llm.operation_id);
  const tool = byOperation.get(result.allowed_tool.operation_id);
  const refused = byOperation.get(result.refusal.operation_id);
  expect(llm).toMatchObject({
    reservation_id: result.allowed_llm.reservation_id,
    customer_id: fixture.customerId,
    trace_id: result.trace_id,
    step_name: 'langgraph.allowed_llm',
    framework: 'langgraph',
    kind: 'llm',
    decision: 'reserved',
    state: 'committed',
    actual_usd: '0.0005',
    usage_operation_id: result.allowed_llm.operation_id,
    usage_kind: 'llm',
    usage_cost_usd: '0.0005',
    actual_input_tokens: '2',
    actual_output_tokens: '3',
    actual_value: null,
    sdk_language: runtime,
    outbox_count: '1',
  });
  expect(llm?.decision_id).toBe(llm?.usage_decision_id);
  expect(llm).toMatchObject({
    request_trace_id: result.trace_id,
    usage_trace_id: result.trace_id,
    outbox_trace_id: result.trace_id,
  });
  expect(llm?.span_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(llm?.parent_span_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(llm?.request_span_id).toBe(llm?.span_id);
  expect(llm?.request_parent_span_id).toBe(llm?.parent_span_id);
  expect(llm?.usage_span_id).toBe(llm?.span_id);
  expect(llm?.usage_parent_span_id).toBe(llm?.parent_span_id);
  expect(llm?.outbox_span_id).toBe(llm?.span_id);
  expect(llm?.outbox_parent_span_id).toBe(llm?.parent_span_id);
  expect(tool).toMatchObject({
    reservation_id: result.allowed_tool.reservation_id,
    customer_id: fixture.customerId,
    trace_id: result.trace_id,
    step_name: 'langgraph.allowed_tool',
    framework: 'langgraph',
    kind: 'tool',
    decision: 'reserved',
    state: 'committed',
    actual_usd: '0.1',
    usage_operation_id: result.allowed_tool.operation_id,
    usage_kind: 'tool',
    usage_cost_usd: '0.1',
    actual_input_tokens: null,
    actual_output_tokens: null,
    actual_value: '1',
    sdk_language: runtime,
    outbox_count: '1',
  });
  expect(tool?.decision_id).toBe(tool?.usage_decision_id);
  expect(tool).toMatchObject({
    request_trace_id: result.trace_id,
    usage_trace_id: result.trace_id,
    outbox_trace_id: result.trace_id,
  });
  expect(tool?.span_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(tool?.parent_span_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(tool?.request_span_id).toBe(tool?.span_id);
  expect(tool?.request_parent_span_id).toBe(tool?.parent_span_id);
  expect(tool?.usage_span_id).toBe(tool?.span_id);
  expect(tool?.usage_parent_span_id).toBe(tool?.parent_span_id);
  expect(tool?.outbox_span_id).toBe(tool?.span_id);
  expect(tool?.outbox_parent_span_id).toBe(tool?.parent_span_id);
  expect(refused).toMatchObject({
    decision_id: result.refusal.decision_id,
    reservation_id: null,
    customer_id: fixture.customerId,
    trace_id: result.trace_id,
    step_name: runtime === 'typescript' ? 'langgraph.refused_llm' : 'langgraph.refused_tool',
    framework: 'langgraph',
    kind: runtime === 'typescript' ? 'llm' : 'tool',
    decision: 'denied',
    state: 'refused',
    reserved_usd: '0',
    actual_usd: '0',
    released_usd: '0',
    deciding_rule_key: fixture.ruleKey,
    usage_operation_id: null,
    usage_decision_id: null,
    usage_kind: null,
    usage_cost_usd: null,
    outbox_count: '0',
  });
  expect(Number(refused?.requested_usd)).toBeGreaterThan(Number(refused?.remaining_usd));

  const [account] = await withBuilder(
    fixture.builderId,
    (tx) => tx<{ committed_usd: string; reserved_usd: string; unresolved_usd: string }[]>`
      SELECT
        public.pylva_budget_decimal_text(committed_usd) AS committed_usd,
        public.pylva_budget_decimal_text(reserved_usd) AS reserved_usd,
        public.pylva_budget_decimal_text(unresolved_usd) AS unresolved_usd
      FROM public.budget_accounts
      WHERE builder_id = ${fixture.builderId}::UUID
        AND rule_key = ${fixture.ruleKey}::UUID
        AND subject_customer_id IS NULL
        AND period_start <= pg_catalog.clock_timestamp()
        AND period_end > pg_catalog.clock_timestamp()
    `,
  );
  expect(account).toEqual({ committed_usd: '0.1005', reserved_usd: '0', unresolved_usd: '0' });
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'langgraph_authoritative_sdk' });
  try {
    await applyMigrationsThrough(scratch, '051');
  } catch (error) {
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
}, 60_000);

afterEach(async () => {
  await Promise.all([
    ...[...servers].map((server) => server.stop()),
    ...[...runners].map((runner) => runner.stop()),
    ...[...sentinels].map((sentinel) => sentinel.stop()),
  ]);
  sentinels.clear();
});

afterAll(async () => {
  await Promise.all([
    ...[...servers].map((server) => server.stop()),
    ...[...runners].map((runner) => runner.stop()),
    ...[...sentinels].map((sentinel) => sentinel.stop()),
  ]);
  sentinels.clear();
  await scratch?.drop();
  scratch = undefined;
});

describe('real LangGraph SDK-to-authoritative-backend journeys', () => {
  it('allows one LLM and one priced tool, then refuses before dispatch in both SDKs', async () => {
    const server = await startServer();
    const sentinel = await startEgressSentinel();
    sentinels.add(sentinel);
    const typescriptFixture = await createControlledBuilder('typescript');
    const pythonFixture = await createControlledBuilder('python');

    // Keep artifact processes sequential: it makes any attribution failure
    // unambiguous while still exercising independent backend authorities.
    const typescript = await runJourney(
      'typescript',
      typescriptFixture,
      server.endpoint,
      sentinel.endpoint,
    );
    assertRunnerResult('typescript', typescriptFixture, typescript);
    await assertBackendClosure('typescript', typescriptFixture, typescript);

    const python = await runJourney('python', pythonFixture, server.endpoint, sentinel.endpoint);
    assertRunnerResult('python', pythonFixture, python);
    await assertBackendClosure('python', pythonFixture, python);
    expect(sentinel.requestCount()).toBe(0);

    const counts = await requestCounts(server);
    expect(counts['GET /api/v1/budget/capabilities']).toBe(2);
    expect(counts['POST /api/v1/budget/reservations']).toBe(6);
    expect(counts['POST /api/v1/events']).toBeUndefined();
    expect(
      Object.entries(counts)
        .filter(([route]) => /\/commit$/.test(route))
        .reduce((total, [, count]) => total + count, 0),
    ).toBe(4);
    expect([...server.stderr].join('')).not.toContain(typescriptFixture.apiKey);
    expect([...server.stderr].join('')).not.toContain(pythonFixture.apiKey);
  }, 240_000);
});
