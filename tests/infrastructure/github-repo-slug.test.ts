import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CANONICAL_PUBLIC_REPO_PATTERN = /\b[Pp]ylva\/pylva\b/;
const PRODUCTION_DEPLOY_REPO = 'Pylva/pylva-internal'; // OIDC sub is case-sensitive.
const LOWERCASE_PRODUCTION_DEPLOY_REPO_LITERAL = '"pylva/pylva-internal"';
const LEGACY_REPOS = ['SpaceGravity/pylva', 'SpaceGravity/agentmeter'];

const PUBLIC_DEPLOYMENT_FACING_ROOTS = [
  'src',
  'packages',
  'docs',
  '.github/workflows',
  'infrastructure/modules',
];

const OPTIONAL_DEPLOYMENT_FACING_ROOTS = [
  'infrastructure/envs/staging-app',
  'infrastructure/envs/prod-app',
];

const APP_ENV_REPO_FILES = [
  'infrastructure/envs/staging-app/variables.tf',
  'infrastructure/envs/staging-app/terraform.tfvars.example',
  'infrastructure/envs/prod-app/variables.tf',
  'infrastructure/envs/prod-app/terraform.tfvars.example',
];
// The concrete github_repos value lives in the tfvars example; variables.tf
// declares github_repos as required (no default) so a bare apply can't silently
// narrow the live role trust.
const APP_ENV_OIDC_VALUE_FILES = [
  'infrastructure/envs/staging-app/terraform.tfvars.example',
  'infrastructure/envs/prod-app/terraform.tfvars.example',
];
const STAGING_APP_ENV_VARIABLES_FILE = 'infrastructure/envs/staging-app/variables.tf';
const PROD_APP_ENV_VARIABLES_FILE = 'infrastructure/envs/prod-app/variables.tf';
const OIDC_TRANSITION_CONTRACT_FILES = new Set([
  'infrastructure/modules/app/variables.tf',
  ...APP_ENV_REPO_FILES,
]);
const missingAppEnvRepoFiles = APP_ENV_REPO_FILES.filter((file) => !existsSync(file));
const hasNoAppEnvRepoFiles = missingAppEnvRepoFiles.length === APP_ENV_REPO_FILES.length;

const TEXT_FILE_EXTENSIONS = new Set([
  '.css',
  '.hcl',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mdx',
  '.mjs',
  '.tf',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function hasTextExtension(path: string): boolean {
  return [...TEXT_FILE_EXTENSIONS].some((extension) => path.endsWith(extension));
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('GitHub repository slug references', () => {
  it('keeps public and deployment-facing surfaces off the legacy repo slug', () => {
    const publicFiles = PUBLIC_DEPLOYMENT_FACING_ROOTS.flatMap(walk).filter(hasTextExtension);
    const files = [
      ...publicFiles,
      ...OPTIONAL_DEPLOYMENT_FACING_ROOTS.filter(existsSync).flatMap(walk),
    ].filter(hasTextExtension);

    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter(
      (file) =>
        !OIDC_TRANSITION_CONTRACT_FILES.has(file) &&
        LEGACY_REPOS.some((repo) => readFileSync(file, 'utf8').includes(repo)),
    );
    const publicCanonicalReferences = publicFiles.filter(
      (file) =>
        !file.startsWith('infrastructure/modules/') &&
        CANONICAL_PUBLIC_REPO_PATTERN.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toEqual([]);
    expect(publicCanonicalReferences.length).toBeGreaterThan(0);
  });

  it.skipIf(hasNoAppEnvRepoFiles)(
    'keeps app env GitHub OIDC defaults aligned to the internal deploy repo slug',
    () => {
      expect(missingAppEnvRepoFiles).toEqual([]);

      for (const file of APP_ENV_REPO_FILES) {
        expect(readFileSync(file, 'utf8'), file).not.toContain(
          LOWERCASE_PRODUCTION_DEPLOY_REPO_LITERAL,
        );
      }

      for (const file of APP_ENV_OIDC_VALUE_FILES) {
        expect(readFileSync(file, 'utf8'), file).toContain(`"${PRODUCTION_DEPLOY_REPO}"`);
      }

      const stagingVariables = readFileSync(STAGING_APP_ENV_VARIABLES_FILE, 'utf8');
      expect(stagingVariables).not.toContain('"SpaceGravity/pylva"');
      expect(stagingVariables).not.toContain('"SpaceGravity/agentmeter"');

      const prodVariables = readFileSync(PROD_APP_ENV_VARIABLES_FILE, 'utf8');
      expect(prodVariables).not.toContain('"SpaceGravity/pylva"');
      expect(prodVariables).not.toContain('"SpaceGravity/agentmeter"');
    },
  );
});
