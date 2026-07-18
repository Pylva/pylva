// Track 3 PR 3.3 — explicit-client registry for failover (O6).
//
// The legacy SDK relied on auto-patching the user's provider SDKs on import.
// That works for telemetry but can't reach a *backup* provider's client to
// fulfill reliability_failover when the primary goes down — the wrapper has
// no handle to call into.
//
// Per Rev-2 O6, callers now pass explicit provider clients to the
// Pylva constructor; the constructor registers them here and the
// failover engine consults the registry to pick the right client at call
// time.
//
// Registration is process-wide (matches the auto-patch model). Multiple
// Pylva instances in the same process share the registry — the last
// registered client wins per provider.

import { registerIdentityResetter } from './identity_registry.js';

export type RegisteredProvider = string;

const registry = new Map<string, unknown>();

export function registerProviderClient(provider: RegisteredProvider, client: unknown): void {
  if (provider.trim().length === 0) return;
  registry.set(provider, client);
}

export function registerProviderClients(providers: Record<string, unknown>): void {
  for (const [provider, client] of Object.entries(providers)) {
    registerProviderClient(provider, client);
  }
}

export function getRegisteredClient(provider: string): unknown | null {
  return registry.get(provider) ?? null;
}

export function hasRegisteredClient(provider: string): boolean {
  return getRegisteredClient(provider) !== null;
}

// Test-only reset.
export function _resetClientRegistry(): void {
  registry.clear();
}

registerIdentityResetter(_resetClientRegistry);
