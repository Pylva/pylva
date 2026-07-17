// The canonical runtime validates first, synchronously resets every registered
// old-identity owner, and only then publishes the new configuration.

import { init, snapshotNonLlmConfig, type InitConfig, type RuntimeConfig } from './config.js';
import { configureNonLlmPolicy, type NonLlmConfig } from './non_llm_policy.js';

export function installSdkConfig(config: InitConfig): RuntimeConfig {
  // init() completes all potentially-throwing validation before it resets or
  // publishes identity. The policy configurator receives only that frozen,
  // semantically validated snapshot and is a total synchronous assignment.
  const resolved = init(config);
  configureNonLlmPolicy(resolved.nonLlm);
  return resolved;
}

/** Validate/detach callback-only non-LLM options without installing identity. */
export function snapshotStandaloneNonLlmConfig(
  config: NonLlmConfig | undefined,
): NonLlmConfig | undefined {
  return snapshotNonLlmConfig(config);
}
