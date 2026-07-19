export type ServiceRunnerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createServiceRunnerFetch(options: {
  endpoint: string;
  networkFetch: typeof fetch;
  providerHandler?: ServiceRunnerFetch;
}): ServiceRunnerFetch;

export function assertEgressSentinelBlocked(
  guardedFetch: ServiceRunnerFetch,
  sentinelUrl: string | undefined,
): Promise<void>;
