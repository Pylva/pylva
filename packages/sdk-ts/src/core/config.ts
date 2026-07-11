// SDK configuration — D19 (sync format validation, async backend validation).
//
// init() throws synchronously on malformed apiKey. Backend validation is
// fire-and-forget — the first successful ingest confirms; a first 401 logs a
// loud error and drops the buffered batch (handled in telemetry.ts).

import type { NonLlmConfig } from './non_llm_policy.js';

export interface InitConfig {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushInterval?: number; // ms
  localMode?: boolean;
  nonLlm?: NonLlmConfig;
}

export interface ResolvedConfig {
  apiKey: string;
  endpoint: string;
  batchSize: number;
  flushInterval: number;
  localMode: boolean;
  nonLlm?: NonLlmConfig;
}

// One universal key: pv_live_* is the standard prefix; pv_cli_* keys from the
// retired data-import type remain valid everywhere.
const API_KEY_PATTERN = /^pv_(?:live|cli)_[a-f0-9]{8}_[a-f0-9]{32}$/;

let currentConfig: ResolvedConfig | null = null;

export class InvalidApiKeyError extends Error {
  constructor(message = 'Invalid Pylva API key format') {
    super(`[pylva] ${message}`);
    this.name = 'InvalidApiKeyError';
  }
}

export function isValidApiKeyFormat(apiKey: string): boolean {
  return API_KEY_PATTERN.test(apiKey);
}

export function init(config: InitConfig): void {
  if (typeof config !== 'object' || config === null) {
    throw new InvalidApiKeyError('init() requires a config object');
  }
  if (typeof config.apiKey !== 'string' || !isValidApiKeyFormat(config.apiKey)) {
    throw new InvalidApiKeyError('apiKey must match pv_(live|cli)_{8 hex}_{32 hex} format');
  }
  currentConfig = {
    apiKey: config.apiKey,
    endpoint: config.endpoint ?? 'https://api.pylva.com',
    batchSize: config.batchSize ?? 100,
    flushInterval: config.flushInterval ?? 5000,
    localMode: config.localMode ?? false,
    nonLlm: config.nonLlm,
  };
}

export function getConfig(): ResolvedConfig | null {
  return currentConfig;
}

export function requireConfig(): ResolvedConfig {
  if (!currentConfig) {
    throw new Error('[pylva] SDK not initialized; call pylva.init({ apiKey }) first');
  }
  return currentConfig;
}

export function isInitialized(): boolean {
  return currentConfig !== null;
}

// Test-only: reset between tests. Not exported from the public index.
export function _resetConfigForTests(): void {
  currentConfig = null;
}
