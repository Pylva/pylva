import { and, asc, count, eq, ilike, isNull, lte, or } from 'drizzle-orm';
import { withRLS } from '@/lib/db/rls';
import { customerPricing, customers } from '@/lib/db/schema';

const MAX_CUSTOMER_SELECTOR_LIMIT = 500;

export interface CustomerSelectorOption {
  id: string;
  external_id: string;
  name: string | null;
  email: string | null;
}

export interface CustomerSelectorSearchResult {
  customers: CustomerSelectorOption[];
  limit: number;
  has_more: boolean;
}

function boundedSelectorLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_CUSTOMER_SELECTOR_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_CUSTOMER_SELECTOR_LIMIT);
}

export async function searchCustomerSelectorOptions(
  builderId: string,
  search: string,
  limit: number,
): Promise<CustomerSelectorSearchResult> {
  const boundedLimit = boundedSelectorLimit(limit);
  const trimmedSearch = search.trim();
  const pattern = `%${trimmedSearch}%`;
  const rows = await withRLS(builderId, async (tx) => {
    const builderFilter = eq(customers.builder_id, builderId);
    const whereClause =
      trimmedSearch.length > 0
        ? and(
            builderFilter,
            or(
              ilike(customers.external_id, pattern),
              ilike(customers.name, pattern),
              ilike(customers.email, pattern),
            ),
          )
        : builderFilter;

    return tx
      .select({
        id: customers.id,
        external_id: customers.external_id,
        name: customers.name,
        email: customers.email,
      })
      .from(customers)
      .where(whereClause)
      .orderBy(asc(customers.external_id))
      .limit(boundedLimit + 1);
  });

  return {
    customers: rows.slice(0, boundedLimit),
    limit: boundedLimit,
    has_more: rows.length > boundedLimit,
  };
}

export async function customerExternalIdExists(
  builderId: string,
  externalId: string,
): Promise<boolean> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.builder_id, builderId), eq(customers.external_id, externalId)))
      .limit(1),
  );
  return rows.length > 0;
}

// B4-4c margin evaluation — the internal↔external id bridge. customers.id
// (uuid) keys customer_pricing; external_id keys rules targeting and (via
// the composite prefix) ClickHouse cost_events. Margin math needs both in
// one row, so join once here instead of N lookups in the evaluator.
export interface PricedCustomerRef {
  /** customers.id — internal uuid, keys customer_pricing. */
  id: string;
  /** builder-chosen id — keys rules targeting + ClickHouse composite. */
  external_id: string;
}

/**
 * Every customer with an OPEN pricing version (effective_to IS NULL,
 * already effective at `at`). This is the audience revenue can be computed
 * for; customers without a row here take a margin rule's
 * insufficient_revenue_data_treatment path.
 */
export async function listCustomersWithOpenPricing(
  builderId: string,
  at: Date = new Date(),
): Promise<PricedCustomerRef[]> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .selectDistinct({ id: customers.id, external_id: customers.external_id })
      .from(customers)
      .innerJoin(
        customerPricing,
        and(
          eq(customerPricing.builder_id, builderId),
          eq(customerPricing.customer_id, customers.id),
          isNull(customerPricing.effective_to),
          lte(customerPricing.effective_from, at),
        ),
      )
      .where(eq(customers.builder_id, builderId))
      .orderBy(asc(customers.external_id)),
  );
  return rows;
}

export async function countCustomers(builderId: string): Promise<number> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({ value: count() })
      .from(customers)
      .where(eq(customers.builder_id, builderId)),
  );
  return rows[0]?.value ?? 0;
}
