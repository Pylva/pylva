// SPDX-License-Identifier: Elastic-2.0
export type StripeConfigurationVariable = 'STRIPE_SECRET_KEY' | 'STRIPE_API_VERSION';

export class StripeConfigurationError extends Error {
  readonly code = 'stripe_configuration_missing';

  constructor(readonly variable: StripeConfigurationVariable) {
    super(`Stripe billing is not configured: ${variable} is missing`);
    this.name = 'StripeConfigurationError';
  }
}

export function isStripeConfigurationError(err: unknown): err is StripeConfigurationError {
  return (
    err instanceof StripeConfigurationError ||
    (err instanceof Error && err.name === 'StripeConfigurationError')
  );
}
