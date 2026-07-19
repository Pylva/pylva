import crypto from 'node:crypto';
import {
  assertEgressSentinelBlocked,
  createServiceRunnerFetch,
} from './service-runner-egress-guard.mjs';
import { loadTypescriptSdkArtifact } from './typescript-sdk-artifact.mjs';

const mode = process.env.PYLVA_RUNNER_MODE ?? 'contend';
const endpoint = process.env.PYLVA_RUNNER_ENDPOINT;
const apiKey = process.env.PYLVA_RUNNER_API_KEY;
const count = Number(process.env.PYLVA_RUNNER_COUNT ?? '0');
const prefix = process.env.PYLVA_RUNNER_PREFIX ?? 'typescript';

if (!endpoint || !apiKey || !Number.isSafeInteger(count) || count < 0 || count > 1_000) {
  throw new Error('invalid TypeScript SDK runner configuration');
}

const guardedFetch = createServiceRunnerFetch({ endpoint, networkFetch: globalThis.fetch });
globalThis.fetch = guardedFetch;

function reserveInput(index) {
  return {
    kind: 'tool',
    operationId: crypto.randomUUID(),
    customerId: `${prefix}_${String(index).padStart(3, '0')}`,
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    parentSpanId: null,
    stepName: 'chaos.sdk.typescript',
    framework: 'none',
    reservationTtlSeconds: 30,
    costSourceSlug: 'chaos-tool',
    toolName: 'chaos_tool',
    metric: 'calls',
    maximumValue: '1',
  };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForRelease() {
  await new Promise((resolve, reject) => {
    process.stdin.once('data', resolve);
    process.stdin.once('error', reject);
    process.stdin.resume();
  });
}

async function main() {
  await assertEgressSentinelBlocked(guardedFetch, process.env.PYLVA_EGRESS_SENTINEL_URL);
  const { evidence, root } = await loadTypescriptSdkArtifact();
  const {
    PylvaBudgetExceeded,
    PylvaControlUnavailableError,
    controlStatus,
    init,
    ready,
    reserveUsage,
  } = root;
  const legacy = mode === 'legacy';
  init({
    apiKey,
    endpoint,
    control: {
      mode: legacy ? 'legacy' : 'enforce',
      onUnavailable: mode === 'old_backend' ? 'allow' : 'deny',
      timeoutMs: 30_000,
    },
  });

  if (legacy) {
    const result = await reserveUsage(reserveInput(0));
    write({
      event: 'result',
      runtime: 'typescript',
      ...evidence,
      decision: result.decision,
      local: result.local,
      ready: null,
    });
    return;
  }

  if (mode === 'old_backend') {
    const isReady = await ready();
    const status = await controlStatus();
    const result = await reserveUsage(reserveInput(0));
    write({
      event: 'result',
      runtime: 'typescript',
      ...evidence,
      decision: result.decision,
      local: result.local,
      ready: isReady,
      reason: status.reason,
      supported: status.supported,
    });
    return;
  }

  if (mode !== 'contend') throw new Error('unsupported TypeScript SDK runner mode');
  if (!(await ready())) throw new Error('TypeScript SDK control did not become ready');
  write({ event: 'ready', runtime: 'typescript', ...evidence });
  await waitForRelease();

  const results = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      try {
        const result = await reserveUsage(reserveInput(index));
        return {
          decision: result.decision,
          reservationId: result.decision === 'reserved' ? result.reservationId : null,
          reservedUsd: result.decision === 'reserved' ? result.reservedUsd : null,
        };
      } catch (error) {
        if (error instanceof PylvaBudgetExceeded) return { decision: 'denied' };
        if (error instanceof PylvaControlUnavailableError) {
          return {
            decision: 'unavailable',
            reason: error.reason,
            retryable: error.retryable,
            status: error.status,
          };
        }
        throw error;
      }
    }),
  );
  const decisions = Object.fromEntries(
    ['reserved', 'denied', 'unavailable'].map((decision) => [
      decision,
      results.filter((result) => result.decision === decision).length,
    ]),
  );
  write({
    event: 'result',
    runtime: 'typescript',
    ...evidence,
    decisions,
    reservationIds: results.flatMap((result) =>
      typeof result.reservationId === 'string' ? [result.reservationId] : [],
    ),
    reservedUsd: [...new Set(results.flatMap((result) => result.reservedUsd ?? []))],
    unavailableEvidence: results.flatMap((result) =>
      result.decision === 'unavailable'
        ? [{ reason: result.reason, retryable: result.retryable, status: result.status }]
        : [],
    ),
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    write({
      event: 'error',
      runtime: 'typescript',
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : 'unknown runner failure',
    });
    process.exit(1);
  });
