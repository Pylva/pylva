import crypto from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { expect } from 'vitest';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Python artifact integration gate requires ${name}`);
  return value;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

export function assertPythonSdkArtifactEvidence(result: Record<string, unknown>): void {
  const workspaceRoot = realpathSync(process.cwd());
  const wheel = realpathSync(requiredEnvironment('PYLVA_PYTHON_WHEEL'));
  const expectedSha256 = requiredEnvironment('PYLVA_PYTHON_WHEEL_SHA256');
  const expectedVersion = requiredEnvironment('PYLVA_PYTHON_ARTIFACT_VERSION');
  const expectedSourceSha = requiredEnvironment('PYLVA_PYTHON_ARTIFACT_SOURCE_SHA');
  const actualSha256 = crypto.createHash('sha256').update(readFileSync(wheel)).digest('hex');

  expect(expectedSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(expectedSourceSha).toMatch(/^[0-9a-f]{40}$/u);
  expect(actualSha256).toBe(expectedSha256);
  expect(result).toMatchObject({
    python_artifact_source_sha: expectedSourceSha,
    python_artifact_version: expectedVersion,
    python_artifact_wheel: wheel,
    python_artifact_wheel_sha256: expectedSha256,
    sdk_version: expectedVersion,
  });
  expect(isWithin(workspaceRoot, wheel)).toBe(false);
}
