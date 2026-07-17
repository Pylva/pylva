import { coreRuntime } from '../internal/core-runtime-state.js';

type IdentityResetter = () => void;

/** Register one synchronous old-identity cleanup callback. */
export function registerIdentityResetter(resetter: IdentityResetter): void {
  coreRuntime.registerIdentityResetter(resetter);
}
