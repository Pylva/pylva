// Propagation context via AsyncLocalStorage.
// pylva.track(customerId, opts?, cb) nests: child spans inherit trace_id
// and use the parent's span_id as parent_span_id.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Framework, type Framework as FrameworkType } from '@pylva/shared/telemetry-values';

export interface TrackContext {
  customer_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  step_name: string | null;
  framework?: FrameworkType;
  run_id: string;
  parent_run_id: string | null;
}

// Published entrypoints import this one physical canonical CJS module. Its
// module cache owns the ALS; no discoverable global rendezvous is involved.
const als = new AsyncLocalStorage<TrackContext>();

export function currentContext(): TrackContext | undefined {
  return als.getStore();
}

// Matches the backend's per-event customer_id schema. track() warns (never
// throws — R1) so builders learn at dev time instead of discovering that the
// backend rejected the events: rejected traffic is unbilled AND budget rules
// never apply to it.
const CUSTOMER_ID_RE = /^[a-zA-Z0-9_-]{1,255}$/;
const warnedInvalidCustomerIds = new Set<string>();

function warnInvalidCustomerId(customerId: unknown): void {
  const key = String(customerId).slice(0, 64);
  if (warnedInvalidCustomerIds.has(key) || warnedInvalidCustomerIds.size > 1000) return;
  warnedInvalidCustomerIds.add(key);
  console.warn(
    `[pylva] track(): customer_id ${JSON.stringify(key)} does not match ^[a-zA-Z0-9_-]{1,255}$ — ` +
      'the backend will reject its events, so this traffic is unbilled and budget rules will not ' +
      'apply to it. Use a stable alphanumeric/_/- id.',
  );
}

export interface TrackOptions {
  step?: string;
  framework?: FrameworkType;
}

type TrackCallback<T> = () => Promise<T> | T;

export function track<T>(customerId: string, cb: TrackCallback<T>): Promise<T> | T;
export function track<T>(
  customerId: string,
  opts: TrackOptions,
  cb: TrackCallback<T>,
): Promise<T> | T;
export function track<T>(
  customerId: string,
  optsOrCb: TrackOptions | TrackCallback<T>,
  cb?: TrackCallback<T>,
): Promise<T> | T {
  let options: TrackOptions = {};
  let callback: TrackCallback<T>;
  if (typeof optsOrCb === 'function') {
    callback = optsOrCb;
  } else {
    options = optsOrCb;
    if (!cb) {
      throw new Error('[pylva] track(customerId, opts, cb): cb is required when opts is provided');
    }
    callback = cb;
  }

  if (typeof customerId !== 'string' || !CUSTOMER_ID_RE.test(customerId)) {
    warnInvalidCustomerId(customerId);
  }

  const parent = als.getStore();
  const ctx: TrackContext = {
    customer_id: customerId,
    trace_id: parent?.trace_id ?? randomUUID(),
    span_id: randomUUID(),
    parent_span_id: parent?.span_id ?? null,
    step_name: options.step ?? parent?.step_name ?? null,
    framework: options.framework ?? parent?.framework ?? Framework.NONE,
    run_id: randomUUID(),
    parent_run_id: parent?.run_id ?? null,
  };

  return als.run(ctx, callback);
}

// Test-only helper; not exported from index.
export function _runInContext<T>(ctx: TrackContext, cb: TrackCallback<T>): Promise<T> | T {
  return als.run(ctx, cb);
}
