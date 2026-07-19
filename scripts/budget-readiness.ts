import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type {
  BudgetControlCutoverMode,
  BudgetControlReadiness,
} from '../src/lib/budget-control/readiness.js';

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const OPERATOR_ID_PATTERN = /^[a-z0-9][a-z0-9._:@/+\-]{0,127}$/iu;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._:@/+\-]{0,191}$/iu;
const ACTIONS = new Set<BudgetReadinessAction>(['inspect', 'create', 'refresh', 'mark-ready']);
const MODES = new Set<BudgetControlCutoverMode>(['next_period', 'exact_backfill']);
const POSTURE_ERROR_CODES = new Set([
  'attestation_query_failed',
  'credential_invalid',
  'credential_isolation_failed',
  'credential_missing',
  'dangerous_role_membership',
  'invalid_attestation',
  'missing_expiry_discovery_execute',
  'missing_projection_discovery_execute',
  'missing_runtime_membership',
  'protected_object_ownership',
  'row_security_disabled',
  'schema_incomplete',
  'unsafe_discovery_function',
  'unsafe_login_acl',
  'unsafe_login_role',
  'unsafe_runtime_acl',
  'unsafe_runtime_role',
]);

export const BUDGET_READINESS_USAGE =
  'usage: pnpm budget:readiness -- --action inspect|create|refresh|mark-ready --builder <uuid> [--mode next_period|exact_backfill]';

export type BudgetReadinessAction = 'inspect' | 'create' | 'refresh' | 'mark-ready';

export interface BudgetReadinessArguments {
  action: BudgetReadinessAction;
  builderId: string;
  mode: BudgetControlCutoverMode | null;
}

export interface BudgetReadinessOperatorContext {
  actor: string;
  runId: string;
  candidateSha: string;
  markReadyConfirmation: string | null;
}

interface BudgetRuntimePosture {
  ready: boolean;
  reason: string | null;
  attested: boolean;
  credential_source: 'dedicated' | 'local_ci_fallback' | null;
}

export interface BudgetReadinessDependencies {
  getRuntimePosture(): Promise<BudgetRuntimePosture>;
  getReadiness(builderId: string): Promise<BudgetControlReadiness>;
  createCutover(builderId: string, mode: BudgetControlCutoverMode): Promise<BudgetControlReadiness>;
  refreshCutover(builderId: string): Promise<BudgetControlReadiness>;
  markReady(builderId: string): Promise<BudgetControlReadiness>;
  isExactBackfillAdapterConfigured(): boolean;
  close(): Promise<void>;
}

export interface BudgetReadinessCommandOptions {
  argv: readonly string[];
  environment: Readonly<Record<string, string | undefined>>;
  dependencies?: BudgetReadinessDependencies;
  now?: () => Date;
  newErrorReference?: () => string;
  write?: (line: string) => void;
}

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export class BudgetReadinessUsageError extends Error {
  constructor() {
    super(BUDGET_READINESS_USAGE);
    this.name = 'BudgetReadinessUsageError';
  }
}

export class BudgetReadinessEnvironmentError extends Error {
  readonly code:
    | 'dedicated_credential_required'
    | 'invalid_candidate_sha'
    | 'invalid_operator_actor'
    | 'invalid_operator_run_id'
    | 'production_environment_required';

  constructor(code: BudgetReadinessEnvironmentError['code']) {
    super(code);
    this.name = 'BudgetReadinessEnvironmentError';
    this.code = code;
  }
}

function optionPairs(argv: readonly string[]): Map<string, string> {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  if (normalized.length === 0 || normalized.length % 2 !== 0) {
    throw new BudgetReadinessUsageError();
  }

  const options = new Map<string, string>();
  for (let index = 0; index < normalized.length; index += 2) {
    const name = normalized[index];
    const value = normalized[index + 1];
    if (
      (name !== '--action' && name !== '--builder' && name !== '--mode') ||
      value === undefined ||
      options.has(name)
    ) {
      throw new BudgetReadinessUsageError();
    }
    options.set(name, value);
  }
  return options;
}

export function parseBudgetReadinessArguments(argv: readonly string[]): BudgetReadinessArguments {
  const options = optionPairs(argv);
  const action = options.get('--action');
  const rawBuilderId = options.get('--builder');
  const rawMode = options.get('--mode');

  if (
    action === undefined ||
    !ACTIONS.has(action as BudgetReadinessAction) ||
    rawBuilderId === undefined ||
    !UUID_PATTERN.test(rawBuilderId)
  ) {
    throw new BudgetReadinessUsageError();
  }

  if (action === 'create') {
    if (rawMode === undefined || !MODES.has(rawMode as BudgetControlCutoverMode)) {
      throw new BudgetReadinessUsageError();
    }
  } else if (rawMode !== undefined) {
    throw new BudgetReadinessUsageError();
  }

  return {
    action: action as BudgetReadinessAction,
    builderId: rawBuilderId.toLowerCase(),
    mode: action === 'create' ? (rawMode as BudgetControlCutoverMode) : null,
  };
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function readBudgetReadinessOperatorContext(
  environment: Readonly<Record<string, string | undefined>>,
): BudgetReadinessOperatorContext {
  if (environment['NODE_ENV'] !== 'production') {
    throw new BudgetReadinessEnvironmentError('production_environment_required');
  }
  if (
    nonBlank(environment['BUDGET_CONTROL_DATABASE_URL']) === undefined ||
    ![undefined, 'false'].includes(environment['ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK'])
  ) {
    throw new BudgetReadinessEnvironmentError('dedicated_credential_required');
  }

  const actor = nonBlank(environment['PYLVA_OPERATOR_ACTOR']);
  if (actor === undefined || !OPERATOR_ID_PATTERN.test(actor)) {
    throw new BudgetReadinessEnvironmentError('invalid_operator_actor');
  }
  const runId = nonBlank(environment['PYLVA_OPERATOR_RUN_ID']);
  if (runId === undefined || !RUN_ID_PATTERN.test(runId)) {
    throw new BudgetReadinessEnvironmentError('invalid_operator_run_id');
  }
  const candidateSha = nonBlank(environment['PYLVA_CANDIDATE_SHA']);
  if (candidateSha === undefined || !GIT_SHA_PATTERN.test(candidateSha)) {
    throw new BudgetReadinessEnvironmentError('invalid_candidate_sha');
  }

  return {
    actor,
    runId,
    candidateSha: candidateSha.toLowerCase(),
    markReadyConfirmation: nonBlank(environment['PYLVA_OPERATOR_CONFIRM_MARK_READY']) ?? null,
  };
}

/** Deterministic key ordering for the closed JSON values emitted by this command. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;

  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`)
    .join(',')}}`;
}

export function canonicalSha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function readinessJson(readiness: BudgetControlReadiness): JsonValue {
  if (!readiness.ready) {
    return {
      cutover_at: readiness.cutover_at,
      mode: readiness.mode,
      ready: false,
      reason: readiness.reason,
    };
  }
  return {
    cutover_at: readiness.cutover_at,
    mode: readiness.mode,
    ready: true,
    ready_at: readiness.ready_at,
    ready_order: readiness.ready_order,
  };
}

function baseAuditRecord(
  event: 'budget_readiness.before' | 'budget_readiness.result',
  arguments_: BudgetReadinessArguments,
  context: BudgetReadinessOperatorContext,
  observedAt: string,
): { readonly [key: string]: JsonValue } {
  return {
    action: arguments_.action,
    actor: context.actor,
    builder_id: arguments_.builderId,
    candidate_sha: context.candidateSha,
    event,
    observed_at: observedAt,
    requested_mode: arguments_.mode,
    run_id: context.runId,
    schema_version: '1.0',
  };
}

function beforeRecord(
  arguments_: BudgetReadinessArguments,
  context: BudgetReadinessOperatorContext,
  readiness: BudgetControlReadiness,
  observedAt: string,
): { line: string; sha256: string } {
  const payload = {
    ...baseAuditRecord('budget_readiness.before', arguments_, context, observedAt),
    readiness: readinessJson(readiness),
  } satisfies { readonly [key: string]: JsonValue };
  const recordSha256 = canonicalSha256(payload);
  return {
    line: canonicalJson({ ...payload, record_sha256: recordSha256 }),
    sha256: recordSha256,
  };
}

function resultRecord(input: {
  arguments: BudgetReadinessArguments;
  context: BudgetReadinessOperatorContext;
  readiness: BudgetControlReadiness | null;
  observedAt: string;
  outcome: 'error' | 'success';
  beforeRecordSha256: string | null;
  errorCode?: string;
  errorReference?: string;
}): string {
  const payload = {
    ...baseAuditRecord('budget_readiness.result', input.arguments, input.context, input.observedAt),
    before_record_sha256: input.beforeRecordSha256,
    outcome: input.outcome,
    readiness: input.readiness === null ? null : readinessJson(input.readiness),
    ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
    ...(input.errorReference === undefined ? {} : { error_ref: input.errorReference }),
  } satisfies { readonly [key: string]: JsonValue };
  const resultSha256 = canonicalSha256(payload);
  return canonicalJson({ ...payload, result_sha256: resultSha256 });
}

function markReadyConfirmation(arguments_: BudgetReadinessArguments, candidateSha: string): string {
  return `mark-ready:${arguments_.builderId}:${candidateSha}`;
}

function postureErrorCode(posture: BudgetRuntimePosture): string {
  return posture.reason !== null && POSTURE_ERROR_CODES.has(posture.reason)
    ? posture.reason
    : 'dedicated_runtime_attestation_required';
}

function transitionError(
  arguments_: BudgetReadinessArguments,
  before: BudgetControlReadiness,
  dependencies: BudgetReadinessDependencies,
  context: BudgetReadinessOperatorContext,
): string | null {
  if (arguments_.action === 'create') {
    if (before.mode !== null && before.mode !== arguments_.mode) return 'immutable_mode_conflict';
    return null;
  }
  if (arguments_.action === 'refresh') {
    return !before.ready && before.reason === 'pending' ? null : 'pending_cutover_required';
  }
  if (arguments_.action === 'mark-ready') {
    if (context.markReadyConfirmation !== markReadyConfirmation(arguments_, context.candidateSha)) {
      return 'mark_ready_confirmation_required';
    }
    if (!before.ready && before.reason === 'missing') return 'pending_cutover_required';
    if (
      !before.ready &&
      before.mode === 'exact_backfill' &&
      !dependencies.isExactBackfillAdapterConfigured()
    ) {
      return 'exact_backfill_adapter_unavailable';
    }
  }
  return null;
}

async function performAction(
  arguments_: BudgetReadinessArguments,
  before: BudgetControlReadiness,
  dependencies: BudgetReadinessDependencies,
): Promise<BudgetControlReadiness> {
  switch (arguments_.action) {
    case 'inspect':
      return before;
    case 'create':
      return dependencies.createCutover(arguments_.builderId, arguments_.mode!);
    case 'refresh':
      return dependencies.refreshCutover(arguments_.builderId);
    case 'mark-ready':
      return dependencies.markReady(arguments_.builderId);
  }
}

async function loadBudgetReadinessDependencies(): Promise<BudgetReadinessDependencies> {
  const [readiness, posture, adapter, client] = await Promise.all([
    import('../src/lib/budget-control/readiness.js'),
    import('../src/lib/budget-control/runtime-posture.js'),
    import('../src/lib/budget-control/exact-backfill-adapter.js'),
    import('../src/lib/budget-control/client.js'),
  ]);
  return {
    getRuntimePosture: posture.getBudgetControlProductionPosture,
    getReadiness: readiness.getBudgetControlReadiness,
    createCutover: readiness.createBudgetControlCutover,
    refreshCutover: readiness.refreshBudgetControlCutover,
    markReady: readiness.markBudgetControlReady,
    isExactBackfillAdapterConfigured: adapter.isBudgetExactBackfillAdapterConfigured,
    close: client.closeBudgetControlDb,
  };
}

export async function runBudgetReadinessCommand(
  options: BudgetReadinessCommandOptions,
): Promise<number> {
  const arguments_ = parseBudgetReadinessArguments(options.argv);
  const context = readBudgetReadinessOperatorContext(options.environment);
  const dependencies = options.dependencies ?? (await loadBudgetReadinessDependencies());
  const now = options.now ?? (() => new Date());
  const newErrorReference = options.newErrorReference ?? randomUUID;
  const write = options.write ?? console.log;

  try {
    let posture: BudgetRuntimePosture;
    try {
      posture = await dependencies.getRuntimePosture();
    } catch {
      write(
        resultRecord({
          arguments: arguments_,
          context,
          readiness: null,
          observedAt: now().toISOString(),
          outcome: 'error',
          beforeRecordSha256: null,
          errorCode: 'runtime_attestation_failed',
          errorReference: newErrorReference(),
        }),
      );
      return 1;
    }
    if (!posture.ready || !posture.attested || posture.credential_source !== 'dedicated') {
      write(
        resultRecord({
          arguments: arguments_,
          context,
          readiness: null,
          observedAt: now().toISOString(),
          outcome: 'error',
          beforeRecordSha256: null,
          errorCode: postureErrorCode(posture),
          errorReference: newErrorReference(),
        }),
      );
      return 1;
    }

    let before: BudgetControlReadiness;
    try {
      before = await dependencies.getReadiness(arguments_.builderId);
    } catch {
      write(
        resultRecord({
          arguments: arguments_,
          context,
          readiness: null,
          observedAt: now().toISOString(),
          outcome: 'error',
          beforeRecordSha256: null,
          errorCode: 'readiness_read_failed',
          errorReference: newErrorReference(),
        }),
      );
      return 1;
    }
    const beforeAudit = beforeRecord(arguments_, context, before, now().toISOString());
    write(beforeAudit.line);

    const validationError = transitionError(arguments_, before, dependencies, context);
    if (validationError !== null) {
      write(
        resultRecord({
          arguments: arguments_,
          context,
          readiness: before,
          observedAt: now().toISOString(),
          outcome: 'error',
          beforeRecordSha256: beforeAudit.sha256,
          errorCode: validationError,
          errorReference: newErrorReference(),
        }),
      );
      return 1;
    }

    try {
      const result = await performAction(arguments_, before, dependencies);
      write(
        resultRecord({
          arguments: arguments_,
          context,
          readiness: result,
          observedAt: now().toISOString(),
          outcome: 'success',
          beforeRecordSha256: beforeAudit.sha256,
        }),
      );
      return 0;
    } catch {
      let current: BudgetControlReadiness | null = null;
      try {
        current = await dependencies.getReadiness(arguments_.builderId);
      } catch {
        // The audit record stays closed and truthful when the follow-up read also fails.
      }
      write(
        resultRecord({
          arguments: arguments_,
          context,
          readiness: current,
          observedAt: now().toISOString(),
          outcome: 'error',
          beforeRecordSha256: beforeAudit.sha256,
          errorCode: 'operation_failed',
          errorReference: newErrorReference(),
        }),
      );
      return 1;
    }
  } finally {
    try {
      await dependencies.close();
    } catch {
      // Never replace the authoritative operation result with a credential-bearing close error.
    }
  }
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const helpArguments = argv[0] === '--' ? argv.slice(1) : argv;
  if (helpArguments.length === 1 && helpArguments[0] === '--help') {
    console.log(BUDGET_READINESS_USAGE);
    console.log(
      'mark-ready additionally requires PYLVA_OPERATOR_CONFIRM_MARK_READY=mark-ready:<builder>:<candidate-sha>',
    );
    return;
  }

  try {
    process.exitCode = await runBudgetReadinessCommand({
      argv,
      environment: process.env,
    });
  } catch (error) {
    const usageError = error instanceof BudgetReadinessUsageError;
    const errorCode =
      error instanceof BudgetReadinessEnvironmentError
        ? error.code
        : usageError
          ? 'invalid_arguments'
          : 'command_failed';
    console.log(canonicalJson({ error: errorCode, outcome: 'error', schema_version: '1.0' }));
    if (usageError) console.error(BUDGET_READINESS_USAGE);
    process.exitCode = usageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run();
}
