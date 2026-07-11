// R6 abort propagation — estimates abort_savings_usd using the pricing cache.

import { getPricing } from './pricing_cache.js';

export interface AbortSavingsInput {
  provider: string | null;
  model: string | null;
  tokensGenerated: number;
  maxTokensExpected: number | null;
}

/** Compute abort_savings_usd = cached price * (expected - generated) output tokens. */
export function computeAbortSavingsUsd(input: AbortSavingsInput): number {
  const { provider, model, tokensGenerated, maxTokensExpected } = input;
  if (!provider || !model || maxTokensExpected == null || maxTokensExpected <= tokensGenerated) {
    return 0;
  }
  const pricing = getPricing(provider, model);
  if (!pricing) return 0;
  const unusedTokens = maxTokensExpected - tokensGenerated;
  return Math.round(((unusedTokens * pricing.output_per_1m) / 1_000_000) * 1_000_000) / 1_000_000;
}
