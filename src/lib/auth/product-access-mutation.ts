import type { DrizzleTransaction } from '../db/rls.js';
import { withRLS } from '../db/rls.js';
import { getBuilderEntitlementForShare } from '../db/advisory-locks.js';
import { ProductAccessMutationDeniedError } from './product-access-mutation-error.js';

export {
  ProductAccessMutationDeniedError,
  isProductAccessMutationDeniedError,
} from './product-access-mutation-error.js';

/**
 * Linearize a tenant mutation against checkout/suspension transitions.
 *
 * `getBuilderEntitlementForShare` locks the authoritative builder row in the
 * same transaction passed to `mutation`. A lifecycle UPDATE must therefore
 * commit before this check (and deny the mutation) or wait until the already
 * authorized mutation commits.
 */
export async function withProductAccessMutation<T>(
  builderId: string,
  mutation: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> {
  return withRLS(builderId, async (tx) => {
    const resolution = await getBuilderEntitlementForShare(tx, builderId);
    if (resolution === null || !resolution.ok || !resolution.entitlement.has_product_access) {
      throw new ProductAccessMutationDeniedError(builderId);
    }
    return mutation(tx);
  });
}
