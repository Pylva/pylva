import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowDir = path.join(repoRoot, '.github/workflows');

const BOOTSTRAP_COMMAND =
  'pnpm exec tsx scripts/ci/bootstrap-authoritative-budget-migration-role.ts';
const DB_SETUP_COMMAND = 'pnpm db:setup';
const GENERAL_APP_PROVISION_COMMAND = 'pnpm exec tsx scripts/ci/provision-general-app-runtime.ts';
const RUNTIME_PROVISION_COMMAND =
  'pnpm exec tsx scripts/ci/provision-authoritative-budget-runtime.ts';
const MIGRATION_RUNNER = 'tests/integration/migration-runner.test.ts';
const RUNTIME_ROLES_SUITE =
  'tests/integration/authoritative-budget-control-runtime-roles-migration.test.ts';
const GENERAL_APP_PROVISIONER_TRANSACTION_SUITE =
  'tests/integration/provision-general-app-runtime.test.ts';
const RUNTIME_PROVISIONER_TRANSACTION_SUITE =
  'tests/integration/provision-authoritative-budget-runtime.test.ts';
const CI_POSTGRES_ADMIN_URL = 'postgresql://pylva:pylva_test@localhost:5432/pylva_test';
const MIGRATION_DATABASE_URL =
  'postgresql://pylva_migration_ci:pylva_migration_ci_test@localhost:5432/pylva_test';
const TEST_DATABASE_ADMIN_URL =
  'postgresql://pylva_migration_ci:pylva_migration_ci_test@localhost:5432/postgres';
const GENERAL_APP_DATABASE_URL =
  'postgresql://pylva_app_ci:pylva_app_ci_test@localhost:5432/pylva_test';
const RUNTIME_DATABASE_URL =
  'postgresql://pylva_budget_control_ci:pylva_budget_control_ci_test@localhost:5432/pylva_test';

interface ServiceJob {
  file: string;
  job: string;
}

const serviceJobs: ServiceJob[] = [
  {
    file: 'authoritative-budget-control-ci.yml',
    job: 'authoritative-integration',
  },
  {
    file: 'authoritative-budget-control-ci.yml',
    job: 'authoritative-dashboard-e2e',
  },
  { file: 'ci-integration.yml', job: 'ci-db-security' },
  { file: 'ci-integration.yml', job: 'ci-full-services' },
  { file: 'ci-e2e-smoke.yml', job: 'ci-e2e-smoke' },
  { file: 'self-host-smoke.yml', job: 'self-host-smoke' },
];

function workflow(filename: string): string {
  return fs.readFileSync(path.join(workflowDir, filename), 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jobBlock(source: string, jobName: string): string {
  const startMatch = new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, 'mu').exec(source);
  expect(startMatch, `workflow job ${jobName} must exist`).not.toBeNull();

  const start = startMatch!.index;
  const remainder = source.slice(start + startMatch![0].length);
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/mu.exec(remainder);
  const end = nextJob ? start + startMatch![0].length + nextJob.index : source.length;
  return source.slice(start, end);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function effectiveJobText(source: string, block: string): string {
  const jobsIndex = source.indexOf('\njobs:');
  expect(jobsIndex, 'workflow must contain a jobs mapping').toBeGreaterThanOrEqual(0);
  return `${source.slice(0, jobsIndex)}\n${block}`;
}

function effectiveStepText(source: string, block: string, step: string): string {
  const jobsIndex = source.indexOf('\njobs:');
  const stepsIndex = block.indexOf('\n    steps:');
  expect(jobsIndex, 'workflow must contain a jobs mapping').toBeGreaterThanOrEqual(0);
  expect(stepsIndex, 'workflow job must contain steps').toBeGreaterThanOrEqual(0);
  return `${source.slice(0, jobsIndex)}\n${block.slice(0, stepsIndex)}\n${step}`;
}

function stepContaining(source: string, command: string): string {
  const commandIndex = source.indexOf(command);
  expect(commandIndex, `workflow step must contain ${command}`).toBeGreaterThanOrEqual(0);

  const priorStep = source.lastIndexOf('\n      - ', commandIndex);
  const start = priorStep >= 0 ? priorStep + 1 : 0;
  const nextStep = source.indexOf('\n      - ', commandIndex + command.length);
  return source.slice(start, nextStep >= 0 ? nextStep : source.length);
}

describe('authoritative budget-control CI topology', () => {
  it('triggers the focused PR gate for every pre-main migration contract input', () => {
    const source = workflow('authoritative-budget-control-ci.yml');
    const pullRequestStart = source.indexOf('  pull_request:');
    const pushStart = source.indexOf('\n  push:', pullRequestStart);
    const pullRequestBlock = source.slice(pullRequestStart, pushStart);

    expect(pullRequestStart).toBeGreaterThanOrEqual(0);
    expect(pushStart).toBeGreaterThan(pullRequestStart);
    for (const requiredPath of [
      '.github/workflows/**',
      'db/clickhouse/**',
      'db/clickhouse-statements.ts',
      'db/migrations/**',
      'db/seed.ts',
      'db/seeds/**',
      'package.json',
      'packages/sdk-py/**',
      'packages/sdk-ts/**',
      'packages/shared/**',
      'scripts/**',
      'src/app/api/**',
      'src/app/o/**/dashboard/**',
      'src/app/portal/**',
      'src/components/**',
      'src/lib/**',
      'tests/**',
      'vitest*.ts',
    ]) {
      expect(pullRequestBlock, `focused workflow must trigger for ${requiredPath}`).toContain(
        `- '${requiredPath}'`,
      );
    }
  });

  it('bootstraps the ordinary migration principal before every service-backed db:setup', () => {
    const allWorkflowText = fs
      .readdirSync(workflowDir)
      .filter((filename) => filename.endsWith('.yml') || filename.endsWith('.yaml'))
      .map(workflow)
      .join('\n');

    expect(occurrences(allWorkflowText, DB_SETUP_COMMAND)).toBe(serviceJobs.length);
    expect(occurrences(allWorkflowText, BOOTSTRAP_COMMAND)).toBe(serviceJobs.length);

    for (const { file, job } of serviceJobs) {
      const block = jobBlock(workflow(file), job);
      const installIndex = block.indexOf('pnpm install --frozen-lockfile');
      const bootstrapIndex = block.indexOf(BOOTSTRAP_COMMAND);
      const dbSetupIndex = block.indexOf(DB_SETUP_COMMAND);
      const bootstrapStep = stepContaining(block, BOOTSTRAP_COMMAND);
      const dbSetupStep = stepContaining(block, DB_SETUP_COMMAND);

      expect(occurrences(block, BOOTSTRAP_COMMAND), `${file}:${job} bootstrap count`).toBe(1);
      expect(occurrences(block, DB_SETUP_COMMAND), `${file}:${job} db:setup count`).toBe(1);
      expect(installIndex, `${file}:${job} installs before bootstrap`).toBeGreaterThanOrEqual(0);
      expect(bootstrapIndex, `${file}:${job} contains bootstrap`).toBeGreaterThan(installIndex);
      expect(dbSetupIndex, `${file}:${job} contains db:setup`).toBeGreaterThan(bootstrapIndex);
      expect(
        occurrences(bootstrapStep, `CI_POSTGRES_ADMIN_URL: ${CI_POSTGRES_ADMIN_URL}`),
        `${file}:${job} gives only the bootstrap its CI admin URL`,
      ).toBe(1);
      expect(bootstrapStep, `${file}:${job} bootstraps the isolated migration URL`).toContain(
        `MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`,
      );
      expect(dbSetupStep, `${file}:${job} migrates through the isolated migration URL`).toContain(
        `MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`,
      );
      expect(dbSetupStep, `${file}:${job} keeps the admin URL out of db:setup`).not.toContain(
        'CI_POSTGRES_ADMIN_URL:',
      );
    }
  });

  it('provisions every service job through an ordinary general-app login', () => {
    const allWorkflowText = fs
      .readdirSync(workflowDir)
      .filter((filename) => filename.endsWith('.yml') || filename.endsWith('.yaml'))
      .map(workflow)
      .join('\n');

    expect(occurrences(allWorkflowText, GENERAL_APP_PROVISION_COMMAND)).toBe(serviceJobs.length);

    for (const { file, job } of serviceJobs) {
      const source = workflow(file);
      const block = jobBlock(source, job);
      const effective = effectiveJobText(source, block);
      const dbSetupIndex = block.indexOf(DB_SETUP_COMMAND);
      const generalProvisionIndex = block.indexOf(GENERAL_APP_PROVISION_COMMAND);
      const generalProvisionStep = stepContaining(block, GENERAL_APP_PROVISION_COMMAND);
      const budgetProvisionIndex = block.indexOf(RUNTIME_PROVISION_COMMAND);

      expect(
        occurrences(block, GENERAL_APP_PROVISION_COMMAND),
        `${file}:${job} provision count`,
      ).toBe(1);
      expect(
        effective,
        `${file}:${job} uses the ordinary general-app login for DATABASE_URL`,
      ).toContain(`DATABASE_URL: ${GENERAL_APP_DATABASE_URL}`);
      expect(
        effective,
        `${file}:${job} must not serve through the bootstrap superuser`,
      ).not.toContain('DATABASE_URL: postgresql://pylva:pylva_test@localhost:5432/pylva_test');
      expect(generalProvisionIndex).toBeGreaterThan(dbSetupIndex);
      if (budgetProvisionIndex >= 0) {
        expect(budgetProvisionIndex).toBeGreaterThan(generalProvisionIndex);
      }
      expect(generalProvisionStep).toContain(`MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`);
      expect(generalProvisionStep).toContain(
        `GENERAL_APP_DATABASE_URL: ${GENERAL_APP_DATABASE_URL}`,
      );
      expect(generalProvisionStep).not.toContain('CI_POSTGRES_ADMIN_URL:');
    }
  });

  it('scopes the scratch admin URL to integration-test steps only', () => {
    const authoritativeSource = workflow('authoritative-budget-control-ci.yml');
    const authoritativeBlock = jobBlock(authoritativeSource, 'authoritative-integration');
    for (const testPath of [
      MIGRATION_RUNNER,
      'tests/integration/authoritative-budget-ledger-migration.test.ts',
      'tests/integration/authoritative-budget-transaction.test.ts',
      'tests/integration/authoritative-budget-chaos.test.ts',
      'tests/integration/authoritative-budget-projection-postgres.test.ts',
      'tests/integration/langgraph-authoritative-sdk-e2e.test.ts',
    ]) {
      expect(stepContaining(authoritativeBlock, testPath), testPath).toContain(
        `PYLVA_TEST_DATABASE_ADMIN_URL: ${TEST_DATABASE_ADMIN_URL}`,
      );
    }

    const generalBoundaryStep = stepContaining(
      authoritativeBlock,
      'tests/integration/general-app-runtime-owner-boundary.test.ts',
    );
    expect(generalBoundaryStep).toContain(`MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`);
    expect(generalBoundaryStep).toContain(`GENERAL_APP_DATABASE_URL: ${GENERAL_APP_DATABASE_URL}`);
    expect(generalBoundaryStep).not.toContain('PYLVA_TEST_DATABASE_ADMIN_URL:');

    for (const [source, block] of [
      [authoritativeSource, authoritativeBlock],
      [
        workflow('ci-integration.yml'),
        jobBlock(workflow('ci-integration.yml'), 'ci-full-services'),
      ],
    ] as const) {
      const generalProvisionerBoundaryStep = stepContaining(
        block,
        GENERAL_APP_PROVISIONER_TRANSACTION_SUITE,
      );
      expect(effectiveStepText(source, block, generalProvisionerBoundaryStep)).toContain(
        `CI_POSTGRES_ADMIN_URL: ${CI_POSTGRES_ADMIN_URL}`,
      );
      expect(generalProvisionerBoundaryStep).toContain(
        `MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`,
      );
      expect(generalProvisionerBoundaryStep).toContain(
        `GENERAL_APP_DATABASE_URL: ${GENERAL_APP_DATABASE_URL}`,
      );
      expect(generalProvisionerBoundaryStep).not.toContain('PYLVA_TEST_DATABASE_ADMIN_URL:');

      const provisionerBoundaryStep = stepContaining(block, RUNTIME_PROVISIONER_TRANSACTION_SUITE);
      expect(effectiveStepText(source, block, provisionerBoundaryStep)).toContain(
        `MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`,
      );
      expect(provisionerBoundaryStep).toContain(
        `GENERAL_APP_DATABASE_URL: ${GENERAL_APP_DATABASE_URL}`,
      );
      expect(provisionerBoundaryStep).not.toContain('PYLVA_TEST_DATABASE_ADMIN_URL:');
    }

    const integrationSource = workflow('ci-integration.yml');
    const dbSecurityBlock = jobBlock(integrationSource, 'ci-db-security');
    const legacyIntegrationStep = stepContaining(
      dbSecurityBlock,
      "--exclude 'tests/integration/authoritative-*.test.ts'",
    );
    expect(legacyIntegrationStep).toContain(
      `PYLVA_TEST_DATABASE_ADMIN_URL: ${TEST_DATABASE_ADMIN_URL}`,
    );
    const fullServicesBlock = jobBlock(integrationSource, 'ci-full-services');
    const fullIntegrationStep = stepContaining(
      fullServicesBlock,
      "--exclude 'tests/integration/authoritative-budget-control-runtime-roles-migration.test.ts'",
    );
    expect(fullIntegrationStep).toContain(
      `PYLVA_TEST_DATABASE_ADMIN_URL: ${TEST_DATABASE_ADMIN_URL}`,
    );

    for (const { file, job } of [
      { file: 'authoritative-budget-control-ci.yml', job: 'authoritative-dashboard-e2e' },
      { file: 'ci-e2e-smoke.yml', job: 'ci-e2e-smoke' },
      { file: 'self-host-smoke.yml', job: 'self-host-smoke' },
    ]) {
      expect(jobBlock(workflow(file), job), `${file}:${job}`).not.toContain(
        'PYLVA_TEST_DATABASE_ADMIN_URL:',
      );
    }
  });

  it('keeps admin and provisioning credentials out of seeds, builds, and app servers', () => {
    const sensitiveCommands = ['pnpm db:seed', 'pnpm build', 'pnpm exec next start'];
    const protectedNames = [
      'CI_POSTGRES_ADMIN_URL:',
      'MIGRATION_DATABASE_URL:',
      'GENERAL_APP_DATABASE_URL:',
      'PYLVA_TEST_DATABASE_ADMIN_URL:',
    ];

    for (const { file, job } of serviceJobs) {
      const source = workflow(file);
      const block = jobBlock(source, job);
      for (const command of sensitiveCommands) {
        if (!block.includes(command)) continue;
        const effectiveStep = effectiveStepText(source, block, stepContaining(block, command));
        for (const protectedName of protectedNames) {
          expect(effectiveStep, `${file}:${job}:${command} leaks ${protectedName}`).not.toContain(
            protectedName,
          );
        }
      }
    }
  });

  it('runs cluster-global scratch migration contracts before the main database migration', () => {
    const block = jobBlock(
      workflow('authoritative-budget-control-ci.yml'),
      'authoritative-integration',
    );
    const bootstrapIndex = block.indexOf(BOOTSTRAP_COMMAND);
    const migrationRunnerIndex = block.indexOf(MIGRATION_RUNNER);
    const runtimeRolesIndex = block.indexOf(RUNTIME_ROLES_SUITE);
    const dbSetupIndex = block.indexOf(DB_SETUP_COMMAND);

    expect(occurrences(block, MIGRATION_RUNNER)).toBe(1);
    expect(occurrences(block, RUNTIME_ROLES_SUITE)).toBe(1);
    expect(migrationRunnerIndex).toBeGreaterThan(bootstrapIndex);
    expect(runtimeRolesIndex).toBeGreaterThan(migrationRunnerIndex);
    expect(dbSetupIndex).toBeGreaterThan(runtimeRolesIndex);

    const preMainBlock = block.slice(bootstrapIndex, dbSetupIndex);
    expect(preMainBlock).toContain("if: matrix.suite == 'postgresql'");
    expect(preMainBlock).toContain(`DATABASE_URL: ${MIGRATION_DATABASE_URL}`);

    const postMainBlock = block.slice(dbSetupIndex);
    expect(postMainBlock).not.toContain(MIGRATION_RUNNER);
    expect(postMainBlock).not.toContain(RUNTIME_ROLES_SUITE);
  });

  it('keeps the quick legacy DB-security lane away from focused scratch contracts', () => {
    const source = workflow('ci-integration.yml');
    const block = jobBlock(source, 'ci-db-security');
    const requiredExclusions = [
      "--exclude 'tests/integration/authoritative-*.test.ts'",
      "--exclude 'tests/integration/langgraph-*.test.ts'",
      "--exclude 'tests/integration/migration-runner.test.ts'",
      "--exclude 'tests/integration/provision-authoritative-budget-runtime.test.ts'",
      "--exclude 'tests/integration/provision-general-app-runtime.test.ts'",
    ];
    const dbSetupIndex = block.indexOf(DB_SETUP_COMMAND);
    const integrationIndex = block.indexOf(requiredExclusions[0]!);

    expect(integrationIndex, 'ci-db-security integration suite follows db:setup').toBeGreaterThan(
      dbSetupIndex,
    );
    for (const exclusion of requiredExclusions) {
      expect(block, `ci-db-security retains ${exclusion}`).toContain(exclusion);
    }
  });

  it('delegates immutable cross-runtime service gates to the focused artifact workflow', () => {
    const block = jobBlock(workflow('ci-integration.yml'), 'ci-full-services');
    const dbSetupIndex = block.indexOf(DB_SETUP_COMMAND);
    const runtimeProvisionIndex = block.indexOf(RUNTIME_PROVISION_COMMAND);
    const integrationIndex = block.indexOf(
      "--exclude 'tests/integration/authoritative-budget-control-runtime-roles-migration.test.ts'",
    );
    const integrationStep = stepContaining(
      block,
      "--exclude 'tests/integration/authoritative-budget-control-runtime-roles-migration.test.ts'",
    );

    expect(integrationIndex).toBeGreaterThan(block.indexOf('pnpm install --frozen-lockfile'));
    expect(block).toContain(`BUDGET_CONTROL_DATABASE_URL: ${RUNTIME_DATABASE_URL}`);
    expect(block).toContain("ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'false'");
    expect(occurrences(block, RUNTIME_PROVISION_COMMAND)).toBe(1);
    expect(runtimeProvisionIndex).toBeGreaterThan(dbSetupIndex);
    expect(integrationIndex).toBeGreaterThan(runtimeProvisionIndex);
    expect(stepContaining(block, RUNTIME_PROVISION_COMMAND)).toContain(
      `MIGRATION_DATABASE_URL: ${MIGRATION_DATABASE_URL}`,
    );
    expect(block).not.toContain('pnpm --filter @pylva/sdk build');
    expect(block).not.toContain('python -m pip wheel');
    expect(integrationStep).toContain(
      "--exclude 'tests/integration/authoritative-budget-chaos.test.ts'",
    );
    expect(integrationStep).toContain(
      "--exclude 'tests/integration/langgraph-authoritative-sdk-e2e.test.ts'",
    );
    expect(integrationStep).toContain(
      "--exclude 'tests/integration/authoritative-budget-control-runtime-roles-migration.test.ts'",
    );
    expect(integrationStep).toContain("--exclude 'tests/integration/migration-runner.test.ts'");
    expect(integrationStep).toContain(
      "--exclude 'tests/integration/provision-general-app-runtime.test.ts'",
    );
    expect(integrationStep).not.toContain("--exclude 'tests/integration/authoritative-*.test.ts'");
    expect(integrationStep).not.toContain("--exclude 'tests/integration/langgraph-*.test.ts'");

    const focused = jobBlock(
      workflow('authoritative-budget-control-ci.yml'),
      'authoritative-integration',
    );
    expect(focused).toContain('needs: [typescript-package-artifact, python-package-artifact]');
    expect(
      stepContaining(focused, 'tests/integration/authoritative-budget-chaos.test.ts'),
    ).toContain('PYLVA_CHAOS_PYTHON:');
    expect(
      stepContaining(focused, 'tests/integration/langgraph-authoritative-sdk-e2e.test.ts'),
    ).toContain('PYLVA_LANGGRAPH_PYTHON:');
    expect(focused).toContain("'openai==2.45.0'");
    expect(focused).toContain("'respx==0.23.1'");
    expect(focused).toContain('pylva-chaos-venv/bin/python" -m pip check');
    expect(focused).toContain('pylva-langgraph-venv/bin/python" -m pip check');
  });

  it('keeps browser and self-host smoke on test posture with a provisioned runtime login', () => {
    for (const { file, job } of [
      { file: 'ci-e2e-smoke.yml', job: 'ci-e2e-smoke' },
      { file: 'self-host-smoke.yml', job: 'self-host-smoke' },
    ]) {
      const source = workflow(file);
      const block = jobBlock(source, job);
      const dbSetupIndex = block.indexOf(DB_SETUP_COMMAND);
      const runtimeProvisionIndex = block.indexOf(RUNTIME_PROVISION_COMMAND);

      expect(source, `${file} explicitly uses test startup posture`).toContain('NODE_ENV: test');
      expect(source, `${file} configures the dedicated runtime login`).toContain(
        `BUDGET_CONTROL_DATABASE_URL: ${RUNTIME_DATABASE_URL}`,
      );
      expect(source).toContain("ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'false'");
      expect(occurrences(block, RUNTIME_PROVISION_COMMAND), `${file}:${job} provision count`).toBe(
        1,
      );
      expect(
        runtimeProvisionIndex,
        `${file}:${job} provisions the runtime login after migrations`,
      ).toBeGreaterThan(dbSetupIndex);
    }
  });
});
