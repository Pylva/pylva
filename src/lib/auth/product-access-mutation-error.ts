export class ProductAccessMutationDeniedError extends Error {
  readonly code = 'product_access_mutation_denied';

  constructor(readonly builderId: string) {
    super('Mutation denied because the workspace has no product access');
    this.name = 'ProductAccessMutationDeniedError';
  }
}

export function isProductAccessMutationDeniedError(
  error: unknown,
): error is ProductAccessMutationDeniedError {
  return (
    error instanceof ProductAccessMutationDeniedError ||
    (error instanceof Error &&
      (error as Error & { code?: unknown }).code === 'product_access_mutation_denied')
  );
}
