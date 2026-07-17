// Track 3 PR 3.3 — explicit-client SDK constructor (O6).
//
// New public API:
//
//   import OpenAI from 'openai';
//   import Anthropic from '@anthropic-ai/sdk';
//   import { Pylva } from '@pylva/sdk';
//
//   const pylva = new Pylva({
//     apiKey: 'pv_live_...',
//     openai: new OpenAI(),
//     anthropic: new Anthropic(),
//     providers: { openrouter: openrouterClient },
//   });
//
// The constructor:
//  1. Calls the existing init() so config / accumulator / rules-cache
//     bootstrapping is unchanged.
//  2. Registers the supplied clients in the process-wide registry so the
//     failover engine can pick the correct backup client at call time
//     (D52 / O6). Without explicit registration, cross-provider failover
//     surfaces a warning and falls through to the original error.
//
// Telemetry-only deployments can keep using init({ apiKey }); deployments
// that use reliability_failover rules should use this explicit-client
// constructor so backup-provider clients can be registered.

import { type InitConfig } from './core/config.js';
import { installSdkConfig } from './core/identity.js';
import { applyAllPatches } from './wrappers/_patch.js';
import { initAccumulator } from './core/budget_accumulator.js';
import { ensurePricingCache } from './core/pricing_cache.js';
import { ensureRulesCache, getCachedRules } from './core/rules_cache.js';
import { validateFailoverWrappers } from './wrappers/_init_validation.js';
import { registerProviderClient } from './core/client_registry.js';
import {
  ready,
  controlStatus,
  reserveUsage,
  commitUsage,
  releaseUsage,
  extendUsage,
  type CommitUsageInput,
  type CommitUsageResult,
  type ControlReadyResult,
  type ExtendUsageInput,
  type ExtendUsageResult,
  type ReleaseUsageInput,
  type ReleaseUsageResult,
  type ReserveUsageInput,
  type ReserveUsageResult,
} from './core/control_client.js';

export interface PylvaOptions extends InitConfig {
  /** Builder-instantiated OpenAI client used for failover-targeted calls. */
  openai?: unknown;
  /** Builder-instantiated Anthropic client used for failover-targeted calls. */
  anthropic?: unknown;
  /** Builder-instantiated clients keyed by exact provider id. */
  providers?: Record<string, unknown>;
}

export class Pylva {
  readonly hasOpenAi: boolean;
  readonly hasAnthropic: boolean;

  constructor(options: PylvaOptions) {
    const { openai, anthropic, providers, ...initConfig } = options;
    // Materialize arbitrary provider objects before publishing a new SDK
    // identity. Object.entries can execute Proxy traps or property getters;
    // registration from this detached list is total after installation.
    const providerEntries = providers
      ? Object.entries(providers).map(([provider, client]) => ({ provider, client }))
      : [];
    installSdkConfig(initConfig);
    try {
      applyAllPatches();
    } catch {
      /* R1 — never surface patch errors to host */
    }
    if (openai) registerProviderClient('openai', openai);
    if (anthropic) registerProviderClient('anthropic', anthropic);
    for (let index = 0; index < providerEntries.length; index += 1) {
      const entry = providerEntries[index];
      if (entry) registerProviderClient(entry.provider, entry.client);
    }
    this.hasOpenAi = openai != null;
    this.hasAnthropic = anthropic != null;

    void initAccumulator().catch(() => {
      /* R1 */
    });
    // Warm the pricing cache so local budget accounting (recordLlmSpend)
    // can price calls from the first flush onward.
    void ensurePricingCache().catch(() => {
      /* R1 */
    });
    void ensureRulesCache()
      .then(() => validateFailoverWrappers(getCachedRules()))
      .catch(() => {
        /* R1 */
      });
  }

  ready(): Promise<boolean> {
    return ready();
  }

  controlStatus(): Promise<ControlReadyResult> {
    return controlStatus();
  }

  reserveUsage(input: ReserveUsageInput): Promise<ReserveUsageResult> {
    return reserveUsage(input);
  }

  commitUsage(input: CommitUsageInput): Promise<CommitUsageResult> {
    return commitUsage(input);
  }

  releaseUsage(input: ReleaseUsageInput): Promise<ReleaseUsageResult> {
    return releaseUsage(input);
  }

  extendUsage(input: ExtendUsageInput): Promise<ExtendUsageResult> {
    return extendUsage(input);
  }
}

Object.defineProperty(Pylva, 'name', { value: 'Pylva' });
