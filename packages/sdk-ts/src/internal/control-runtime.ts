// Provider-focused authoritative LLM attempt runtime. The public all-cost
// facade stays in the root bundle; deep providers load this one physical
// strict transport/parser without duplicating it across provider files.

export { executeControlledAttempt, safeUint32 } from '../core/control_attempt.js';
export type * from '../core/control_attempt.js';

export {
  createStrictControlContext,
  getStrictCapabilities,
  parseStrictCapabilities,
  parseStrictCommitResponse,
  parseStrictError,
  parseStrictExtendResponse,
  parseStrictReleaseResponse,
  parseStrictReserveResponse,
  strictJsonRequest,
  StrictTransportUnavailable,
} from '../core/strict_attempt_control.js';
export type { StrictCapability, StrictControlContext } from '../core/strict_attempt_control.js';
