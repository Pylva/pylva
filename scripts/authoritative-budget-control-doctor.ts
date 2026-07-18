import { pathToFileURL } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

interface RuntimePosture {
  ready: boolean;
  reason: string | null;
  attested: boolean;
}

interface BuilderReadiness {
  ready: boolean;
  reason?: string;
  mode: string | null;
  cutover_at: string | null;
  ready_order?: string;
  ready_at?: string;
}

export interface DoctorArguments {
  builderId: string;
}

export interface AuthoritativeBudgetControlDoctorReport {
  ready: boolean;
  builder_id: string;
  checks: {
    postgres_runtime: RuntimePosture;
    clickhouse_projection: RuntimePosture;
    builder_cutover: BuilderReadiness;
  };
}

export class DoctorUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorUsageError';
  }
}

export function parseDoctorArguments(argv: readonly string[]): DoctorArguments {
  const normalized = argv[0] === '--' ? argv.slice(1) : argv;
  if (
    normalized.length !== 2 ||
    normalized[0] !== '--builder-id' ||
    !UUID_PATTERN.test(normalized[1] ?? '')
  ) {
    throw new DoctorUsageError('usage: pnpm budget-control:doctor -- --builder-id <uuid>');
  }
  return { builderId: normalized[1]! };
}

export function buildDoctorReport(
  builderId: string,
  postgresRuntime: RuntimePosture,
  clickhouseProjection: RuntimePosture,
  builderCutover: BuilderReadiness,
): AuthoritativeBudgetControlDoctorReport {
  return {
    ready:
      postgresRuntime.ready &&
      postgresRuntime.attested &&
      clickhouseProjection.ready &&
      clickhouseProjection.attested &&
      builderCutover.ready,
    builder_id: builderId,
    checks: {
      postgres_runtime: postgresRuntime,
      clickhouse_projection: clickhouseProjection,
      builder_cutover: builderCutover,
    },
  };
}

async function run(): Promise<void> {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('usage: pnpm budget-control:doctor -- --builder-id <uuid>');
    return;
  }

  try {
    const { builderId } = parseDoctorArguments(process.argv.slice(2));
    if (process.env['NODE_ENV'] !== 'production') {
      console.log(JSON.stringify({ ready: false, error: 'production_environment_required' }));
      process.exitCode = 1;
      return;
    }

    const [runtimeModule, projectionModule, readinessModule] = await Promise.all([
      import('../src/lib/budget-control/runtime-posture.js'),
      import('../src/lib/budget-projection/clickhouse-posture.js'),
      import('../src/lib/budget-control/readiness.js'),
    ]);
    const [postgresRuntime, clickhouseProjection, builderCutover] = await Promise.all([
      runtimeModule.getBudgetControlProductionPosture(),
      projectionModule.getBudgetProjectionClickHousePosture(),
      readinessModule.getBudgetControlReadiness(builderId),
    ]);
    const report = buildDoctorReport(
      builderId,
      postgresRuntime,
      clickhouseProjection,
      builderCutover,
    );
    console.log(JSON.stringify(report));
    if (!report.ready) process.exitCode = 1;
  } catch (error) {
    const usageError = error instanceof DoctorUsageError;
    console.log(
      JSON.stringify({ ready: false, error: usageError ? 'invalid_arguments' : 'probe_failed' }),
    );
    if (usageError) console.error(error.message);
    process.exitCode = usageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void run();
}
