import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { ensureLedger, type MigrateSqlClient } from '../../scripts/db-migrate-core.js';
import { applyMigrationsThrough, createScratchDb } from '../helpers/scratch-db.js';

const SCRIPT = path.resolve('scripts/cli/create-builder.ts');
const TEST_TIMEOUT_MS = 180_000;

function runtimeUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set('options', '-c role=pylva_general_app_runtime');
  return url.toString();
}

function runCli(
  databaseUrl: string,
  args: string[],
  deploymentMode: 'hosted' | 'self_hosted' = 'self_hosted',
) {
  return spawnSync('pnpm', ['exec', 'tsx', SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: runtimeUrl(databaseUrl),
      PYLVA_DEPLOYMENT_MODE: deploymentMode,
    },
  });
}

function startCli(
  databaseUrl: string,
  args: string[],
  deploymentMode: 'hosted' | 'self_hosted',
) {
  const child = spawn('pnpm', ['exec', 'tsx', SCRIPT, ...args], {
    env: {
      ...process.env,
      DATABASE_URL: runtimeUrl(databaseUrl),
      PYLVA_DEPLOYMENT_MODE: deploymentMode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status) => resolve({ status, stderr, stdout }));
    },
  );
  return { child, completion };
}

async function waitForAdvisoryWait(observer: Sql): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waiting = await observer<Array<{ pid: number }>>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'
        AND pid <> pg_backend_pid()
    `;
    if (waiting.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for create-builder to block on the lifecycle lock');
}

describe('create-builder lifecycle contract', () => {
  it(
    'requires an explicit entitlement for a new builder and supports self-hosted without a plan',
    async () => {
      const scratch = await createScratchDb({ prefix: 'builder_lifecycle_cli' });
      try {
        await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
        await applyMigrationsThrough(scratch, '058');
        await scratch.sql.unsafe('SET ROLE pylva_general_app_runtime');
        const email = `self-hosted-${crypto.randomBytes(6).toString('hex')}@example.com`;

        const hostedSelfHosted = runCli(
          scratch.url,
          ['--email', email, '--self-hosted', '--no-key'],
          'hosted',
        );
        expect(hostedSelfHosted.status).toBe(1);
        expect(`${hostedSelfHosted.stdout}\n${hostedSelfHosted.stderr}`).toContain(
          'Cannot provision a self-hosted entitlement in hosted deployment mode.',
        );

        const selfHostedPaid = runCli(scratch.url, ['--email', email, '--plan', 'pro', '--no-key']);
        expect(selfHostedPaid.status).toBe(1);
        expect(`${selfHostedPaid.stdout}\n${selfHostedPaid.stderr}`).toContain(
          'Cannot assign a commercial plan in self-hosted deployment mode.',
        );

        const omitted = runCli(scratch.url, ['--email', email, '--no-key']);
        expect(omitted.status).toBe(1);
        expect(`${omitted.stdout}\n${omitted.stderr}`).toContain(
          'A new builder requires --plan pro|scale|enterprise or --self-hosted.',
        );
        const missingRows = await scratch.sql<Array<{ count: string }>>`
          SELECT count(*)::text AS count
          FROM builders
          WHERE email = ${email}
        `;
        expect(missingRows[0]!.count).toBe('0');

        const created = runCli(scratch.url, ['--email', email, '--self-hosted', '--no-key']);
        expect(created.status).toBe(0);
        expect(created.stdout).toContain('Source: self_hosted');

        const rows = await scratch.sql<
          Array<{
            access_state: string;
            entitlement_source: string;
            tier: string | null;
          }>
        >`
          SELECT tier, access_state, entitlement_source
          FROM builders
          WHERE email = ${email}
        `;
        expect(rows).toEqual([
          {
            access_state: 'active',
            entitlement_source: 'self_hosted',
            tier: null,
          },
        ]);
      } finally {
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serializes an explicit operator entitlement update on the hosted builder lock',
    async () => {
      const scratch = await createScratchDb({ prefix: 'builder_lifecycle_cli_lock' });
      const blocker = postgres(scratch.url, { max: 1, onnotice: () => undefined });
      const observer = postgres(scratch.url, { max: 1, onnotice: () => undefined });
      let releaseLock!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let lockReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        lockReady = resolve;
      });
      let started: ReturnType<typeof startCli> | null = null;

      try {
        await ensureLedger(scratch.sql as unknown as MigrateSqlClient);
        await applyMigrationsThrough(scratch, '058');
        await scratch.sql.unsafe('SET ROLE pylva_general_app_runtime');
        const email = `hosted-lock-${crypto.randomBytes(6).toString('hex')}@example.com`;
        const [builder] = await scratch.sql<Array<{ id: string }>>`
          INSERT INTO builders (
            email,
            tier,
            access_state,
            entitlement_source,
            slug
          )
          VALUES (
            ${email},
            NULL,
            'checkout_required',
            NULL,
            ${`hosted-lock-${crypto.randomBytes(4).toString('hex')}`}
          )
          RETURNING id
        `;

        const held = blocker.begin(async (tx) => {
          await tx`
            SELECT pg_advisory_xact_lock(
              hashtextextended(${builder!.id}, 0)
            )
          `;
          lockReady();
          await release;
        });
        await ready;

        started = startCli(
          scratch.url,
          ['--email', email, '--plan', 'enterprise', '--no-key'],
          'hosted',
        );
        await waitForAdvisoryWait(observer);
        await observer.unsafe('SET ROLE pylva_general_app_runtime');

        const beforeRelease = await observer<
          Array<{
            access_state: string;
            entitlement_source: string | null;
            tier: string | null;
          }>
        >`
          SELECT tier, access_state, entitlement_source
          FROM builders
          WHERE id = ${builder!.id}
        `;
        expect(beforeRelease).toEqual([
          {
            access_state: 'checkout_required',
            entitlement_source: null,
            tier: null,
          },
        ]);

        releaseLock();
        await held;
        const completed = await started.completion;
        expect(`${completed.stdout}\n${completed.stderr}`).toContain('Source: admin');
        expect(completed.status).toBe(0);

        const afterRelease = await observer<
          Array<{
            access_state: string;
            entitlement_source: string | null;
            tier: string | null;
          }>
        >`
          SELECT tier, access_state, entitlement_source
          FROM builders
          WHERE id = ${builder!.id}
        `;
        expect(afterRelease).toEqual([
          {
            access_state: 'active',
            entitlement_source: 'admin',
            tier: 'enterprise',
          },
        ]);
      } finally {
        releaseLock?.();
        if (started && started.child.exitCode === null) started.child.kill('SIGTERM');
        await blocker.end();
        await observer.end();
        await scratch.drop();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
