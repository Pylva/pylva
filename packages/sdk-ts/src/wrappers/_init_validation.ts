// SDK init-time validation — D52. After the rules cache is loaded for
// the first time, scan reliability_failover rules and warn if a backup
// provider's wrapper isn't loaded in this process. Cross-provider
// failover requires the backup wrapper; without it, the primary call
// will proceed and the wrapper emits a per-call `failover_missing_backup`
// warning. The init-time check surfaces the same gap once at startup so
// builders see it before traffic.

import { RuleType, type ReliabilityFailoverConfig } from '@pylva/shared';
import { narrowRules } from '../core/rules_engine.js';
import { hasRegisteredClient } from '../core/client_registry.js';

const PATCHED_PROVIDERS = new Set<string>();

export function markProviderPatched(providerId: string): void {
  PATCHED_PROVIDERS.add(providerId);
}

const warnedPairs = new Set<string>();

// PR #70 follow-up — a builder using `new Pylva({ openai, anthropic })`
// has the backup client available in the registry even if the backup
// wrapper module wasn't imported in user code. The registry counts as
// "backup is reachable" for warning purposes; the runtime engine
// likewise consults the registry before emitting FAILOVER_MISSING_BACKUP.
function isBackupReachable(provider: string): boolean {
  return PATCHED_PROVIDERS.has(provider) || hasRegisteredClient(provider);
}

export function validateFailoverWrappers(rawRules: unknown[]): void {
  let rules;
  try {
    rules = narrowRules(rawRules);
  } catch {
    console.warn(
      '[pylva] failover validation skipped: rules cache returned malformed entries',
    );
    return;
  }
  for (const rule of rules) {
    if (rule.type !== RuleType.RELIABILITY_FAILOVER) continue;
    const cfg = rule.config as unknown as ReliabilityFailoverConfig;
    if (!cfg.enabled) continue;

    const pairKey = `${cfg.primary_provider}|${cfg.backup_provider}`;
    if (warnedPairs.has(pairKey)) continue;
    if (isBackupReachable(cfg.backup_provider)) continue;

    warnedPairs.add(pairKey);
    console.warn(
      `[pylva] reliability_failover rule "${rule.id}" routes ` +
        `${cfg.primary_provider} → ${cfg.backup_provider}, but the ` +
        `${cfg.backup_provider} SDK is neither auto-patched nor passed ` +
        `to the Pylva constructor. Either import the ` +
        `${cfg.backup_provider} SDK or pass an instantiated client via ` +
        `\`new Pylva({ providers: { "${cfg.backup_provider}": client } })\` ` +
        `so failover can route there; ` +
        `otherwise calls continue on the primary and the ` +
        `wrapper logs failover_missing_backup per call.`,
    );
  }
}

export function _resetInitValidationForTests(): void {
  PATCHED_PROVIDERS.clear();
  warnedPairs.clear();
}
