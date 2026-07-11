import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const internalAwsServerlessPaths = [
  'infrastructure/modules',
  'src/lambda',
  'scripts/build-public-api-lambda.ts',
  'scripts/package-lambda-argon2-layer.ts',
  'scripts/package-serverless-next.ts',
  'tests/lambda',
  'tests/scripts/package-lambda-argon2-layer.test.ts',
  'tests/infrastructure/migration-task-terraform.test.ts',
  'tests/infrastructure/prod-edge-api-host.test.ts',
] as const;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function trackedPathExists(relativePath: string): boolean {
  const files = trackedFiles();
  return files.includes(relativePath) || files.some((file) => file.startsWith(`${relativePath}/`));
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('AWS/serverless source boundary', () => {
  it('keeps production Terraform modules, Lambda runtimes, and packaging scripts internal', () => {
    for (const relativePath of internalAwsServerlessPaths) {
      expect(trackedPathExists(relativePath), `${relativePath} should live in pylva-internal`).toBe(
        false,
      );
    }
  });

  it('does not expose hosted Lambda packaging commands in the public package scripts', () => {
    const packageJson = readJson('package.json');
    const scripts = packageJson.scripts as Record<string, string>;

    expect(scripts['build:lambda:public-api']).toBeUndefined();
    expect(scripts['package:lambda:argon2-layer']).toBeUndefined();
    expect(scripts['package:lambda:public-api']).toBeUndefined();
    expect(scripts['package:lambda:serverless-next']).toBeUndefined();
  });
});
