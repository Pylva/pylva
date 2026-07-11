import { pathToFileURL } from 'node:url';
import type { EgressRequest, EgressResponse } from '../src/lib/external-egress-core.js';
import { safeErrorMetadata } from '../src/lib/safe-error-metadata.js';

type ExternalFetcher = (request: EgressRequest) => Promise<EgressResponse>;

interface CheckOptions {
  fetcher?: ExternalFetcher;
  now?: () => number;
  write?: (line: string) => void;
}

const CHECKS: ReadonlyArray<EgressRequest> = [
  {
    target: 'github',
    url: 'https://github.com/login/oauth/access_token',
    timeoutMs: 10_000,
  },
  {
    target: 'google_oauth',
    url: 'https://oauth2.googleapis.com/token',
    timeoutMs: 10_000,
  },
];

async function defaultFetcher(request: EgressRequest): Promise<EgressResponse> {
  const { externalFetch } = await import('../src/lib/external-egress.js');
  return externalFetch(request);
}

export async function runExternalEgressChecks({
  fetcher = defaultFetcher,
  now = performance.now.bind(performance),
  write = (line) => process.stdout.write(`${line}\n`),
}: CheckOptions = {}): Promise<number> {
  let failed = false;

  for (const request of CHECKS) {
    const startedAt = now();
    try {
      const response = await fetcher(request);
      const durationMs = Math.max(0, Math.round(now() - startedAt));
      write(
        JSON.stringify({
          check: 'external_egress',
          duration_ms: durationMs,
          status: response.status,
          target: request.target,
        }),
      );
      if (response.status >= 500) failed = true;
    } catch (error) {
      failed = true;
      write(
        JSON.stringify({
          check: 'external_egress',
          duration_ms: Math.max(0, Math.round(now() - startedAt)),
          target: request.target,
          ...safeErrorMetadata(error),
        }),
      );
    }
  }

  return failed ? 1 : 0;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runExternalEgressChecks();
}
