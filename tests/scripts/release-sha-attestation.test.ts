import { describe, expect, it } from 'vitest';

import {
  eligibleReleaseRuns,
  RELEASE_WORKFLOW_GATES,
  validateRequiredJobs,
} from '../../scripts/ci/attest-release-sha.mjs';

const SHA = 'a'.repeat(40);

function successfulRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    head_sha: SHA,
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    event: 'push',
    updated_at: '2026-07-18T00:00:00Z',
    html_url: 'https://github.example/runs/123',
    ...overrides,
  };
}

function successfulJobs(gate: (typeof RELEASE_WORKFLOW_GATES)[number]) {
  return gate.families.flatMap((family) =>
    Array.from({ length: family.count }, (_unused, index) => ({
      name: index === 0 ? family.value : `${family.value} duplicate ${index}`,
      status: 'completed',
      conclusion: 'success',
    })),
  );
}

describe('release SHA attestation', () => {
  it('accepts only successful push or manual runs for the exact main SHA', () => {
    const response = {
      workflow_runs: [
        successfulRun({ id: 1, event: 'schedule' }),
        successfulRun({ id: 2, head_sha: 'b'.repeat(40) }),
        successfulRun({ id: 3, head_branch: 'feature' }),
        successfulRun({ id: 4, conclusion: 'failure' }),
        successfulRun({ id: 5, event: 'workflow_dispatch' }),
        successfulRun({ id: 6, updated_at: '2026-07-18T01:00:00Z' }),
      ],
    };

    expect(
      (eligibleReleaseRuns(response, SHA) as Array<{ id: number }>).map((run) => run.id),
    ).toEqual([6, 5]);
  });

  it.each(RELEASE_WORKFLOW_GATES)('requires every $workflow job family', (gate) => {
    const jobs = successfulJobs(gate);
    expect(() => validateRequiredJobs(gate, jobs)).not.toThrow();
    expect(() => validateRequiredJobs(gate, jobs.slice(1))).toThrow(/required job family/u);
  });

  it('rejects a skipped required job even when the workflow conclusion was success', () => {
    const gate = RELEASE_WORKFLOW_GATES.find(
      (candidate) => candidate.workflow === 'ci-integration.yml',
    );
    expect(gate).toBeDefined();
    if (gate === undefined) throw new Error('ci-integration release gate is missing');
    const jobs = successfulJobs(gate);
    const first = jobs[0];
    if (first === undefined) throw new Error('ci-integration release jobs are missing');
    jobs[0] = { name: first.name, status: first.status, conclusion: 'skipped' };
    expect(() => validateRequiredJobs(gate, jobs)).toThrow(
      /ci-external-egress-live was completed\/skipped/u,
    );
  });

  it('requires the full authoritative service, package, and browser matrices', () => {
    const gate = RELEASE_WORKFLOW_GATES[0];
    if (gate === undefined) throw new Error('authoritative release gate is missing');
    const names = gate.families.map((family) => family.value);
    expect(names).toEqual(
      expect.arrayContaining([
        'TypeScript SDK source + immutable artifact / Node 20.18.1',
        'TypeScript SDK source + immutable artifact / Node 22.23.1',
        'TypeScript SDK source + immutable artifact / Node 24.18.0',
        'Python SDK source + immutable artifact / Python 3.10',
        'Python SDK source + immutable artifact / Python 3.11',
        'Python SDK source + immutable artifact / Python 3.12',
        'Python SDK source + immutable artifact / Python 3.13',
        'Authoritative integration / postgresql / PostgreSQL 16 / ClickHouse 24.8',
        'Authoritative integration / postgresql / PostgreSQL 17 / ClickHouse 24.8',
        'Authoritative integration / concurrency-chaos / PostgreSQL 16 / ClickHouse 24.8',
        'Authoritative integration / projection-clickhouse / PostgreSQL 16 / ClickHouse 24.8',
        'Authoritative integration / projection-clickhouse / PostgreSQL 16 / ClickHouse 26.5',
        'Authoritative integration / langgraph / PostgreSQL 16 / ClickHouse 24.8',
        'Authoritative budget dashboard journey',
        'Authoritative control full gate',
      ]),
    );
    expect(gate.families.every((family) => family.kind === 'exact' && family.count === 1)).toBe(
      true,
    );
  });

  it('rejects duplicate matrix suffixes even when the family cardinality is unchanged', () => {
    const gate = RELEASE_WORKFLOW_GATES[0];
    if (gate === undefined) throw new Error('authoritative release gate is missing');
    const jobs = successfulJobs(gate);
    const node24 = jobs.findIndex(
      (job) => job.name === 'TypeScript SDK source + immutable artifact / Node 24.18.0',
    );
    const node24Job = jobs[node24];
    if (node24Job === undefined) throw new Error('Node 24 release job is missing');
    jobs[node24] = {
      ...node24Job,
      name: 'TypeScript SDK source + immutable artifact / Node 20.18.1',
    };
    expect(() => validateRequiredJobs(gate, jobs)).toThrow(/Node 20\.18\.1 expected 1, found 2/u);
  });

  it('rejects unapproved matrix suffixes', () => {
    const gate = RELEASE_WORKFLOW_GATES[0];
    if (gate === undefined) throw new Error('authoritative release gate is missing');
    const jobs = successfulJobs(gate);
    const postgres17 = jobs.findIndex(
      (job) =>
        job.name === 'Authoritative integration / postgresql / PostgreSQL 17 / ClickHouse 24.8',
    );
    const postgres17Job = jobs[postgres17];
    if (postgres17Job === undefined) throw new Error('PostgreSQL 17 release job is missing');
    jobs[postgres17] = {
      ...postgres17Job,
      name: 'Authoritative integration / postgresql / PostgreSQL 18 / ClickHouse 24.8',
    };
    expect(() => validateRequiredJobs(gate, jobs)).toThrow(/PostgreSQL 17.*found 0/u);
  });
});
