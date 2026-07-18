import { describe, expect, it, vi } from 'vitest';
import {
  BudgetReadinessEnvironmentError,
  canonicalJson,
  canonicalSha256,
  parseBudgetReadinessArguments,
  readBudgetReadinessOperatorContext,
  runBudgetReadinessCommand,
  type BudgetReadinessDependencies,
} from '../../scripts/budget-readiness.js';
import type { BudgetControlReadiness } from '../../src/lib/budget-control/readiness.js';

const BUILDER_ID = '11111111-1111-4111-8111-111111111111';
const CANDIDATE_SHA = 'a'.repeat(40);
const CUTOVER_AT = '2026-07-18T00:00:00.000Z';
const READY_AT = '2026-07-18T00:00:01.000Z';

const MISSING: BudgetControlReadiness = {
  ready: false,
  reason: 'missing',
  mode: null,
  cutover_at: null,
};
const PENDING_NEXT: BudgetControlReadiness = {
  ready: false,
  reason: 'pending',
  mode: 'next_period',
  cutover_at: CUTOVER_AT,
};
const PENDING_EXACT: BudgetControlReadiness = {
  ready: false,
  reason: 'pending',
  mode: 'exact_backfill',
  cutover_at: CUTOVER_AT,
};
const READY_NEXT: BudgetControlReadiness = {
  ready: true,
  mode: 'next_period',
  cutover_at: CUTOVER_AT,
  ready_order: '17',
  ready_at: READY_AT,
};

function productionEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    BUDGET_CONTROL_DATABASE_URL: 'postgresql://budget_runtime:super-secret@postgres.internal/pylva',
    ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'false',
    PYLVA_OPERATOR_ACTOR: 'deploy:saud',
    PYLVA_OPERATOR_RUN_ID: 'ecs-task/run-17',
    PYLVA_CANDIDATE_SHA: CANDIDATE_SHA,
    ...overrides,
  };
}

function dependencies(
  readiness: BudgetControlReadiness,
  overrides: Partial<BudgetReadinessDependencies> = {},
): BudgetReadinessDependencies {
  return {
    getRuntimePosture: vi.fn(async () => ({
      ready: true,
      reason: null,
      attested: true,
      credential_source: 'dedicated' as const,
    })),
    getReadiness: vi.fn(async () => readiness),
    createCutover: vi.fn(async () => PENDING_NEXT),
    refreshCutover: vi.fn(async () => readiness),
    markReady: vi.fn(async () => READY_NEXT),
    isExactBackfillAdapterConfigured: vi.fn(() => false),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function commandOptions(input: {
  action: 'inspect' | 'create' | 'refresh' | 'mark-ready';
  mode?: 'next_period' | 'exact_backfill';
  environment?: Record<string, string | undefined>;
  dependencies: BudgetReadinessDependencies;
  output: string[];
}) {
  return {
    argv: [
      '--action',
      input.action,
      '--builder',
      BUILDER_ID,
      ...(input.mode === undefined ? [] : ['--mode', input.mode]),
    ],
    environment: input.environment ?? productionEnvironment(),
    dependencies: input.dependencies,
    now: () => new Date('2026-07-18T01:02:03.004Z'),
    newErrorReference: () => '22222222-2222-4222-8222-222222222222',
    write: (line: string) => input.output.push(line),
  };
}

describe('budget readiness operator command', () => {
  it('parses the closed action surface and requires mode only for create', () => {
    expect(
      parseBudgetReadinessArguments([
        '--',
        '--mode',
        'next_period',
        '--builder',
        BUILDER_ID.toUpperCase(),
        '--action',
        'create',
      ]),
    ).toEqual({ action: 'create', builderId: BUILDER_ID, mode: 'next_period' });
    expect(parseBudgetReadinessArguments(['--action', 'inspect', '--builder', BUILDER_ID])).toEqual(
      { action: 'inspect', builderId: BUILDER_ID, mode: null },
    );

    for (const arguments_ of [
      [],
      ['--action', 'create', '--builder', BUILDER_ID],
      ['--action', 'inspect', '--builder', BUILDER_ID, '--mode', 'next_period'],
      ['--action', 'delete', '--builder', BUILDER_ID],
      ['--action', 'inspect', '--builder', 'not-a-uuid'],
      ['--action', 'inspect', '--builder', BUILDER_ID, '--builder', BUILDER_ID],
      ['--action', 'inspect', '--builder', BUILDER_ID, '--url', 'postgres://secret'],
    ]) {
      expect(() => parseBudgetReadinessArguments(arguments_)).toThrow('usage:');
    }
  });

  it('requires the production platform identity and dedicated credential with fallback off', () => {
    expect(readBudgetReadinessOperatorContext(productionEnvironment())).toEqual({
      actor: 'deploy:saud',
      runId: 'ecs-task/run-17',
      candidateSha: CANDIDATE_SHA,
      markReadyConfirmation: null,
    });

    for (const [environment, code] of [
      [productionEnvironment({ NODE_ENV: 'test' }), 'production_environment_required'],
      [
        productionEnvironment({ BUDGET_CONTROL_DATABASE_URL: undefined }),
        'dedicated_credential_required',
      ],
      [
        productionEnvironment({ ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'true' }),
        'dedicated_credential_required',
      ],
      [
        productionEnvironment({ PYLVA_OPERATOR_ACTOR: 'actor with spaces' }),
        'invalid_operator_actor',
      ],
      [productionEnvironment({ PYLVA_OPERATOR_RUN_ID: '' }), 'invalid_operator_run_id'],
      [productionEnvironment({ PYLVA_CANDIDATE_SHA: 'not-a-sha' }), 'invalid_candidate_sha'],
    ] as const) {
      expect(() => readBudgetReadinessOperatorContext(environment)).toThrowError(
        expect.objectContaining<Partial<BudgetReadinessEnvironmentError>>({ code }),
      );
    }
  });

  it('canonicalizes keys recursively and hashes exactly those bytes', () => {
    const value = { z: true, a: { y: null, b: 'value' }, list: [2, 1] } as const;
    expect(canonicalJson(value)).toBe('{"a":{"b":"value","y":null},"list":[2,1],"z":true}');
    expect(canonicalSha256(value)).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
  });

  it('inspects without mutation and emits hash-chained canonical before/result records', async () => {
    const output: string[] = [];
    const deps = dependencies(PENDING_NEXT);
    const exitCode = await runBudgetReadinessCommand(
      commandOptions({ action: 'inspect', dependencies: deps, output }),
    );

    expect(exitCode).toBe(0);
    expect(output).toHaveLength(2);
    expect(deps.createCutover).not.toHaveBeenCalled();
    expect(deps.refreshCutover).not.toHaveBeenCalled();
    expect(deps.markReady).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledOnce();

    const before = JSON.parse(output[0]!) as Record<string, unknown>;
    const result = JSON.parse(output[1]!) as Record<string, unknown>;
    const { record_sha256: beforeHash, ...beforePayload } = before;
    const { result_sha256: resultHash, ...resultPayload } = result;
    expect(beforeHash).toBe(canonicalSha256(beforePayload as never));
    expect(resultHash).toBe(canonicalSha256(resultPayload as never));
    expect(result.before_record_sha256).toBe(beforeHash);
    expect(result.outcome).toBe('success');
    expect(output[0]).toBe(canonicalJson(before as never));
    expect(output[1]).toBe(canonicalJson(result as never));
    expect(output.join('\n')).not.toContain('super-secret');
    expect(output.join('\n')).not.toContain('postgres.internal');
  });

  it('creates idempotently but rejects an immutable mode conflict before mutation', async () => {
    const output: string[] = [];
    const create = vi.fn(async () => PENDING_NEXT);
    const deps = dependencies(MISSING, { createCutover: create });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'create', mode: 'next_period', dependencies: deps, output }),
      ),
    ).toBe(0);
    expect(create).toHaveBeenCalledWith(BUILDER_ID, 'next_period');

    const retryOutput: string[] = [];
    const retryCreate = vi.fn(async () => PENDING_NEXT);
    const retryDeps = dependencies(PENDING_NEXT, { createCutover: retryCreate });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({
          action: 'create',
          mode: 'next_period',
          dependencies: retryDeps,
          output: retryOutput,
        }),
      ),
    ).toBe(0);
    expect(retryCreate).toHaveBeenCalledWith(BUILDER_ID, 'next_period');

    const conflictOutput: string[] = [];
    const conflictDeps = dependencies(PENDING_EXACT);
    expect(
      await runBudgetReadinessCommand(
        commandOptions({
          action: 'create',
          mode: 'next_period',
          dependencies: conflictDeps,
          output: conflictOutput,
        }),
      ),
    ).toBe(1);
    expect(conflictDeps.createCutover).not.toHaveBeenCalled();
    expect(JSON.parse(conflictOutput[1]!).error_code).toBe('immutable_mode_conflict');
  });

  it('refreshes only a pending cutover', async () => {
    const pendingOutput: string[] = [];
    const pendingDeps = dependencies(PENDING_NEXT);
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'refresh', dependencies: pendingDeps, output: pendingOutput }),
      ),
    ).toBe(0);
    expect(pendingDeps.refreshCutover).toHaveBeenCalledWith(BUILDER_ID);

    const readyOutput: string[] = [];
    const readyDeps = dependencies(READY_NEXT);
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'refresh', dependencies: readyDeps, output: readyOutput }),
      ),
    ).toBe(1);
    expect(readyDeps.refreshCutover).not.toHaveBeenCalled();
    expect(JSON.parse(readyOutput[1]!).error_code).toBe('pending_cutover_required');
  });

  it('binds mark-ready confirmation to the builder and candidate SHA', async () => {
    const output: string[] = [];
    const deps = dependencies(PENDING_NEXT);
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'mark-ready', dependencies: deps, output }),
      ),
    ).toBe(1);
    expect(deps.markReady).not.toHaveBeenCalled();
    expect(JSON.parse(output[1]!).error_code).toBe('mark_ready_confirmation_required');

    const confirmedOutput: string[] = [];
    const confirmedDeps = dependencies(PENDING_NEXT);
    expect(
      await runBudgetReadinessCommand(
        commandOptions({
          action: 'mark-ready',
          dependencies: confirmedDeps,
          output: confirmedOutput,
          environment: productionEnvironment({
            PYLVA_OPERATOR_CONFIRM_MARK_READY: `mark-ready:${BUILDER_ID}:${CANDIDATE_SHA}`,
          }),
        }),
      ),
    ).toBe(0);
    expect(confirmedDeps.markReady).toHaveBeenCalledWith(BUILDER_ID);
  });

  it('requires an installed exact-backfill adapter only for the pending transition', async () => {
    const environment = productionEnvironment({
      PYLVA_OPERATOR_CONFIRM_MARK_READY: `mark-ready:${BUILDER_ID}:${CANDIDATE_SHA}`,
    });
    const blockedOutput: string[] = [];
    const blocked = dependencies(PENDING_EXACT);
    expect(
      await runBudgetReadinessCommand(
        commandOptions({
          action: 'mark-ready',
          dependencies: blocked,
          output: blockedOutput,
          environment,
        }),
      ),
    ).toBe(1);
    expect(blocked.markReady).not.toHaveBeenCalled();
    expect(JSON.parse(blockedOutput[1]!).error_code).toBe('exact_backfill_adapter_unavailable');

    const configuredOutput: string[] = [];
    const configured = dependencies(PENDING_EXACT, {
      isExactBackfillAdapterConfigured: vi.fn(() => true),
      markReady: vi.fn(async () => ({ ...READY_NEXT, mode: 'exact_backfill' as const })),
    });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({
          action: 'mark-ready',
          dependencies: configured,
          output: configuredOutput,
          environment,
        }),
      ),
    ).toBe(0);
    expect(configured.markReady).toHaveBeenCalledOnce();

    const alreadyReady = { ...READY_NEXT, mode: 'exact_backfill' as const };
    const retryOutput: string[] = [];
    const retry = dependencies(alreadyReady, {
      markReady: vi.fn(async () => alreadyReady),
    });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({
          action: 'mark-ready',
          dependencies: retry,
          output: retryOutput,
          environment,
        }),
      ),
    ).toBe(0);
    expect(retry.isExactBackfillAdapterConfigured).not.toHaveBeenCalled();
    expect(retry.markReady).toHaveBeenCalledOnce();
  });

  it('never emits raw operation errors or credential-bearing URLs', async () => {
    const output: string[] = [];
    const secret = 'postgresql://operator:secret@internal/private';
    const deps = dependencies(PENDING_NEXT, {
      refreshCutover: vi.fn(async () => {
        throw new Error(secret);
      }),
    });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'refresh', dependencies: deps, output }),
      ),
    ).toBe(1);
    expect(output.join('\n')).not.toContain(secret);
    expect(output.join('\n')).not.toContain('operator:secret');
    expect(JSON.parse(output[1]!).error_code).toBe('operation_failed');
    expect(JSON.parse(output[1]!).error_ref).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('sanitizes failures before the initial readiness snapshot', async () => {
    const secret = 'postgresql://operator:secret@internal/private';
    for (const [overrides, expectedCode] of [
      [
        {
          getRuntimePosture: vi.fn(async () => {
            throw new Error(secret);
          }),
        },
        'runtime_attestation_failed',
      ],
      [
        {
          getReadiness: vi.fn(async () => {
            throw new Error(secret);
          }),
        },
        'readiness_read_failed',
      ],
    ] as const) {
      const output: string[] = [];
      const deps = dependencies(PENDING_NEXT, overrides);
      expect(
        await runBudgetReadinessCommand(
          commandOptions({ action: 'inspect', dependencies: deps, output }),
        ),
      ).toBe(1);
      expect(output).toHaveLength(1);
      expect(output[0]).not.toContain(secret);
      expect(JSON.parse(output[0]!).error_code).toBe(expectedCode);
      expect(JSON.parse(output[0]!).result_sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('refuses a non-attested or fallback runtime before reading builder state', async () => {
    const output: string[] = [];
    const deps = dependencies(PENDING_NEXT, {
      getRuntimePosture: vi.fn(async () => ({
        ready: true,
        reason: null,
        attested: false,
        credential_source: 'local_ci_fallback' as const,
      })),
    });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'inspect', dependencies: deps, output }),
      ),
    ).toBe(1);
    expect(deps.getReadiness).not.toHaveBeenCalled();
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!).error_code).toBe('dedicated_runtime_attestation_required');
  });

  it('allowlists posture error codes instead of echoing an arbitrary reason', async () => {
    const output: string[] = [];
    const secret = 'postgresql://operator:secret@internal/private';
    const deps = dependencies(PENDING_NEXT, {
      getRuntimePosture: vi.fn(async () => ({
        ready: false,
        reason: secret,
        attested: false,
        credential_source: null,
      })),
    });
    expect(
      await runBudgetReadinessCommand(
        commandOptions({ action: 'inspect', dependencies: deps, output }),
      ),
    ).toBe(1);
    expect(output[0]).not.toContain(secret);
    expect(JSON.parse(output[0]!).error_code).toBe('dedicated_runtime_attestation_required');
  });
});
