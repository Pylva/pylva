export class PylvaStrictProviderError extends TypeError {
  readonly code = 'strict_provider_unsupported' as const;

  constructor(
    readonly provider: 'openai' | 'anthropic' | 'vercel-ai',
    readonly reason: string,
  ) {
    super(`[pylva] strict ${provider} call refused: ${reason}`);
    this.name = 'PylvaStrictProviderError';
  }
}
Object.defineProperty(PylvaStrictProviderError, 'name', { value: 'PylvaStrictProviderError' });
