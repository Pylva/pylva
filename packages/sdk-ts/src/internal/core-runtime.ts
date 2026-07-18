// The coordinator is frozen and null-prototype; credentials and mutable state
// remain in its closure and never appear on global symbols or CJS exports.
export {
  AuthenticatedRoute,
  ControlMode,
  ControlUnavailablePolicy,
  DEFAULT_CONTROL_TIMEOUT_MS,
  InvalidApiKeyError,
  InvalidControlConfigError,
  MAX_CONTROL_TIMEOUT_MS,
  MIN_CONTROL_TIMEOUT_MS,
  coreRuntime,
  getConfig,
  getConfigGeneration,
  installResolved,
  isInitialized,
  requireConfig,
} from './core-runtime-state.js';

export type {
  AuthenticatedRequest,
  AuthenticatedResponseSnapshot,
  ControlConfig,
  CoreRuntimeCoordinator,
  InitConfig,
  ResolvedConfig,
  ResolvedControlConfig,
  ResolvedInstallConfig,
  RuntimeConfig,
} from './core-runtime-state.js';
