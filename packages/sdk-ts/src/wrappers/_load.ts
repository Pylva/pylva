// Peer-dep loader usable in both ESM and CJS tsup outputs.
// Each wrapper calls this with 'openai' / '@anthropic-ai/sdk' / 'ai'; if the
// package isn't installed, returns undefined silently (R1 isolation).
//
// import.meta.url works in the ESM build natively and in the CJS build via
// tsup's `shims: true` (__filename-based shim). The previous implementation
// probed it through an indirect eval, which throws SyntaxError in BOTH
// module systems (indirect eval is global scope, where import.meta is
// illegal even behind typeof) — loadPeer returned undefined for every
// specifier at runtime and auto-patch silently instrumented nothing.

import { createRequire } from 'node:module';

export function loadPeer<T>(specifier: string): T | undefined {
  let url = `file://${process.cwd()}/`;
  try {
    url = import.meta.url ?? url;
  } catch {
    // import.meta unavailable in this runtime — keep the cwd fallback.
  }
  try {
    return createRequire(url)(specifier) as T;
  } catch {
    return undefined;
  }
}

/**
 * Patch a provider resource class prototype (e.g. Completions / Messages) on
 * a loaded module shape `{ [exportName]: { prototype: { create } } }`.
 * Returns whether a patch point existed. Shared by the sync (require) and
 * async (ESM import) patch passes of every provider wrapper.
 */
export function patchResourceProto<R extends { create: unknown }>(
  mod: unknown,
  exportName: string,
  patchFn: (proto: R) => void,
): boolean {
  const proto = (mod as Record<string, { prototype?: R } | undefined> | null | undefined)?.[
    exportName
  ]?.prototype;
  if (proto && typeof proto.create === 'function') {
    patchFn(proto);
    return true;
  }
  return false;
}
