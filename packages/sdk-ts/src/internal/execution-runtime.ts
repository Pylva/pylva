// Canonical context/correlation surface shared by root, provider, and
// LangGraph entrypoints. Mutable ALS state stays inside this module closure.

export { currentContext, track } from '../core/context.js';
export type { TrackContext, TrackOptions } from '../core/context.js';

export {
  completeControlledCallback,
  controlledOperationForCallbackStart,
  currentControlledAttempt,
  currentControlledOperation,
  linkControlledCallbackNoDispatch,
  linkLocalControlledCallbackNoDispatch,
  registerControlledCallback,
  runWithControlledOperation,
  withControlledCallbackScope,
} from '../core/control_correlation.js';
export type {
  ControlledAttemptCorrelation,
  ControlledCallbackLink,
  ControlledLlmOperationCorrelation,
  ControlledNoDispatchCorrelation,
  ControlledOperationCorrelation,
  ControlledOperationScopeOptions,
  ControlledToolOperationCorrelation,
} from '../core/control_correlation.js';
