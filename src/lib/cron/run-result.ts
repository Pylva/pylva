// Shared failure semantics for builder-loop cron handlers (health-check,
// detect-anomalies). Both runners isolate per-builder failures with
// Promise.allSettled and fold them into a `result.errors` counter, returning
// normally even when every builder failed.
//
// A run where every scanned builder errored is a systemic failure (e.g.
// ClickHouse down): the route must report it as a failure so EventBridge
// retries and the CloudWatch alarm fires, instead of recording a silent
// success that hides the outage. A partial failure (at least one builder
// succeeded) is NOT a total failure — it stays successful to preserve the
// intentional per-builder isolation, so one flaky builder can't fail the tick.
//
// `errors` can never exceed `scanned_builders` (allSettled yields exactly one
// outcome per builder), so `>=` is equivalent to `===` here and stays correct
// if the accounting ever changes.

export interface CronBuilderRunResult {
  scanned_builders: number;
  errors: number;
}

export function allScannedBuildersFailed(result: CronBuilderRunResult): boolean {
  return result.scanned_builders > 0 && result.errors >= result.scanned_builders;
}
