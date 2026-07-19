#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ACCEPTED_RELEASE_EVENTS = Object.freeze(new Set(['push', 'workflow_dispatch']));

const exact = (name) => Object.freeze({ kind: 'exact', value: name, count: 1 });

export const RELEASE_WORKFLOW_GATES = Object.freeze([
  Object.freeze({
    workflow: 'authoritative-budget-control-ci.yml',
    output: 'authoritative',
    families: Object.freeze([
      exact('Shared wire-contract parity'),
      exact('TypeScript SDK / immutable artifact'),
      exact('TypeScript SDK source + immutable artifact / Node 20.18.1'),
      exact('TypeScript SDK source + immutable artifact / Node 22.23.1'),
      exact('TypeScript SDK source + immutable artifact / Node 24.18.0'),
      exact('Python SDK / immutable artifact'),
      exact('Python SDK source + immutable artifact / Python 3.10'),
      exact('Python SDK source + immutable artifact / Python 3.11'),
      exact('Python SDK source + immutable artifact / Python 3.12'),
      exact('Python SDK source + immutable artifact / Python 3.13'),
      exact('Python SDK / Pydantic 2.5.0 floor'),
      exact('Authoritative integration / postgresql / PostgreSQL 16 / ClickHouse 24.8'),
      exact('Authoritative integration / postgresql / PostgreSQL 17 / ClickHouse 24.8'),
      exact('Authoritative integration / concurrency-chaos / PostgreSQL 16 / ClickHouse 24.8'),
      exact('Authoritative integration / projection-clickhouse / PostgreSQL 16 / ClickHouse 24.8'),
      exact('Authoritative integration / projection-clickhouse / PostgreSQL 16 / ClickHouse 26.5'),
      exact('Authoritative integration / langgraph / PostgreSQL 16 / ClickHouse 24.8'),
      exact('Authoritative budget dashboard journey'),
      exact('Authoritative control full gate'),
    ]),
  }),
  Object.freeze({
    workflow: 'ci-fast.yml',
    output: 'fast',
    families: Object.freeze([
      exact('ci-static'),
      exact('ci-unit-js'),
      exact('ci-egress-runtime-node-20.18.1'),
      exact('ci-egress-runtime-node-22'),
      exact('ci-sdk-py'),
      exact('ci-build-smoke'),
    ]),
  }),
  Object.freeze({
    workflow: 'ci-integration.yml',
    output: 'integration',
    families: Object.freeze([
      exact('ci-external-egress-live'),
      exact('ci-db-security'),
      exact('ci-full-services'),
    ]),
  }),
  Object.freeze({
    workflow: 'ci-e2e-smoke.yml',
    output: 'e2e',
    families: Object.freeze([exact('ci-e2e-smoke')]),
  }),
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function familyMatches(family, jobName) {
  if (family.kind === 'exact') return jobName === family.value;
  throw new Error(`unsupported release job family: ${family.kind}`);
}

export function eligibleReleaseRuns(response, expectedSha) {
  const runs = Array.isArray(response?.workflow_runs) ? response.workflow_runs : [];
  return runs
    .filter(
      (run) =>
        run?.head_sha === expectedSha &&
        run?.head_branch === 'main' &&
        run?.status === 'completed' &&
        run?.conclusion === 'success' &&
        ACCEPTED_RELEASE_EVENTS.has(run?.event),
    )
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
}

export function validateRequiredJobs(gate, jobs) {
  if (!Array.isArray(jobs)) throw new Error(`${gate.workflow} returned no jobs array`);
  for (const family of gate.families) {
    const matching = jobs.filter(
      (job) => typeof job?.name === 'string' && familyMatches(family, job.name),
    );
    if (matching.length !== family.count) {
      throw new Error(
        `${gate.workflow} required job family ${family.value} expected ${family.count}, ` +
          `found ${matching.length}`,
      );
    }
    for (const job of matching) {
      if (job.status !== 'completed' || job.conclusion !== 'success') {
        throw new Error(
          `${gate.workflow} required job ${job.name} was ${job.status}/${job.conclusion ?? 'null'}`,
        );
      }
    }
  }
}

function apiUrl(base, path, query = undefined) {
  const url = new URL(`${base.replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`);
  if (query !== undefined) {
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  }
  return url;
}

async function apiJson({ apiBase, token }, path, query = undefined) {
  const url = apiUrl(apiBase, path, query);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    throw new Error(`GitHub API ${response.status} for ${url.pathname}: ${detail}`);
  }
  return response.json();
}

async function jobsForRun(client, repository, runId) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const response = await apiJson(client, `repos/${repository}/actions/runs/${runId}/jobs`, {
      filter: 'latest',
      per_page: 100,
      page,
    });
    const batch = Array.isArray(response?.jobs) ? response.jobs : [];
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
}

export async function attestReleaseSha({ apiBase, repository, sha, token }) {
  assertNonEmptyString(apiBase, 'apiBase');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('repository must be an owner/name pair');
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error('sha must be a full lowercase commit SHA');
  assertNonEmptyString(token, 'token');

  const client = { apiBase, token };
  const evidence = {};
  for (const gate of RELEASE_WORKFLOW_GATES) {
    const response = await apiJson(
      client,
      `repos/${repository}/actions/workflows/${encodeURIComponent(gate.workflow)}/runs`,
      { head_sha: sha, status: 'completed', per_page: 100 },
    );
    const candidates = eligibleReleaseRuns(response, sha);
    const rejected = [];
    let attested = null;
    for (const run of candidates) {
      try {
        const jobs = await jobsForRun(client, repository, run.id);
        validateRequiredJobs(gate, jobs);
        attested = run;
        break;
      } catch (error) {
        rejected.push(`run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (attested === null) {
      const suffix = rejected.length > 0 ? `; rejected ${rejected.join('; ')}` : '';
      throw new Error(
        `No fully successful ${gate.workflow} run on main exists for exact release SHA ${sha}${suffix}`,
      );
    }
    evidence[gate.output] = Object.freeze({
      workflow: gate.workflow,
      runId: String(attested.id),
      runUrl: assertNonEmptyString(attested.html_url, `${gate.workflow} run URL`),
      event: attested.event,
      updatedAt: attested.updated_at,
    });
  }
  return Object.freeze(evidence);
}

function appendOutputs(outputPath, sha, evidence) {
  const values = { release_sha: sha };
  for (const [prefixName, item] of Object.entries(evidence)) {
    values[`${prefixName}_run_id`] = item.runId;
    values[`${prefixName}_run_url`] = item.runUrl;
  }
  const lines = Object.entries(values).map(([name, value]) => {
    if (!/^[a-z0-9_]+$/u.test(name) || /[\r\n]/u.test(value)) {
      throw new Error(`unsafe GitHub Actions output ${name}`);
    }
    return `${name}=${value}`;
  });
  appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

async function main() {
  const sha = assertNonEmptyString(process.env.RELEASE_SHA, 'RELEASE_SHA');
  const evidence = await attestReleaseSha({
    apiBase: assertNonEmptyString(process.env.GITHUB_API_URL, 'GITHUB_API_URL'),
    repository: assertNonEmptyString(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'),
    sha,
    token: assertNonEmptyString(process.env.GH_TOKEN, 'GH_TOKEN'),
  });
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendOutputs(process.env.GITHUB_OUTPUT, sha, evidence);
  }
  process.stdout.write(`${JSON.stringify({ releaseSha: sha, workflows: evidence }, null, 2)}\n`);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
