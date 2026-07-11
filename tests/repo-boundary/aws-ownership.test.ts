import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ignoredDirs = new Set(['.git', '.terraform', 'node_modules']);
const textExtensions = new Set([
  '.hcl',
  '.json',
  '.md',
  '.tf',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

function listFiles(relativeDir: string): string[] {
  const absoluteDir = path.join(repoRoot, relativeDir);
  if (!fs.existsSync(absoluteDir)) {
    return [];
  }

  const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(repoRoot, relativePath);
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name)) {
        return [];
      }
      return listFiles(relativePath);
    }
    return entry.isFile() && textExtensions.has(path.extname(entry.name)) ? [absolutePath] : [];
  });
}

function readAll(relativeDir: string): string {
  return listFiles(relativeDir)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

describe('AWS ownership boundary', () => {
  it('does not keep the production ECR/ECS image deploy workflow in the public repo', () => {
    expect(fs.existsSync(path.join(repoRoot, '.github/workflows/build-push-image.yml'))).toBe(false);
  });

  it('keeps public workflows limited to CI, self-host smoke tests, and SDK publishing', () => {
    const workflowDir = path.join(repoRoot, '.github/workflows');
    const workflowFiles = fs.readdirSync(workflowDir).sort();

    expect(workflowFiles).toEqual([
      'ci-e2e-smoke.yml',
      'ci-fast.yml',
      'ci-integration.yml',
      'publish-python-sdk.yml',
      'publish-typescript-sdk.yml',
      'self-host-smoke.yml',
    ]);
  });

  it('keeps public GitHub workflows free of AWS production deploy authority', () => {
    const workflowText = readAll('.github/workflows');
    const forbiddenDeployTokens = [
      'AWS_PROD_ECR_PUSH_ROLE_ARN',
      'AWS_PROD_ECR_REPOSITORY_URL',
      'AWS_ECR_PUSH_ROLE_ARN',
      'AWS_ECR_REPOSITORY_URL',
      'aws-actions/configure-aws-credentials',
      'aws-actions/amazon-ecr-login',
      'ECS_AUTO_DEPLOY',
      'ecs update-service',
      'role-to-assume',
      'AWS_ROLE_ARN',
      'ECR_REGISTRY',
      'ECR_REPOSITORY',
      'aws ecr',
      'aws ecs',
      'aws lambda',
      'aws cloudfront',
      'cloudfront create-invalidation',
      'terraform apply',
      'terraform plan',
      's3 sync',
    ];

    for (const token of forbiddenDeployTokens) {
      expect(workflowText, `public workflow must not contain ${token}`).not.toContain(token);
    }
  });

  it('does not allow the public repo as an AWS GitHub OIDC deploy subject', () => {
    const infrastructureText = readAll('infrastructure');

    expect(infrastructureText).not.toMatch(/repo:Pylva\/pylva:ref:refs\/heads\/main/);
    expect(infrastructureText).not.toMatch(/Pylva\/pylva(?!-internal)/);
  });
});
