// The installed build routes every consumer to one hardened canonical CJS
// module. The WeakMap therefore stays closure-private without a global symbol.
const originalByPatched = new WeakMap<Function, Function>();

export function registerPatchedOriginal<T extends Function>(patched: T, original: T): void {
  originalByPatched.set(patched, original);
}

/** Return null when another SDK copy owns an opaque legacy patch. */
export function originalProviderMethod<T extends Function>(candidate: T): T | null {
  const marker = Object.getOwnPropertyDescriptor(candidate, '__pylva_patched');
  if (marker === undefined) return candidate;
  if (marker.get !== undefined || marker.set !== undefined) return null;
  if (marker.value !== true) return candidate;
  return (originalByPatched.get(candidate) as T | undefined) ?? null;
}
