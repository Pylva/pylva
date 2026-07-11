// ClickHouse cost_events stores customer_id as a composite `${builderId}:${external_id}`
// for tenant isolation. The dashboard renders the bare external id from the
// SDK; this helper strips the prefix so we don't leak the internal builder
// UUID to the UI. Used by every dashboard surface that lists customers.

import { and, eq } from 'drizzle-orm';

export function extractExternalCustomerId(composite: string, builderId: string): string {
  const prefix = `${builderId}:`;
  return composite.startsWith(prefix) ? composite.slice(prefix.length) : composite;
}

export function toCompositeCustomerId(builderId: string, externalCustomerId: string): string {
  return `${builderId}:${externalCustomerId}`;
}

// Forward resolution: internal customers.id UUID → composite key for CH.
// Returns null when the customer doesn't exist or doesn't belong to this
// builder; callers treat that as "no data" rather than throwing. Used by
// portal data layer and invoice generator (both flows receive the internal
// UUID via PG joins / FKs but need the composite to query ClickHouse).
//
// Lazy DB / schema imports — keeps this module a string-only utility at
// load time so test files that pull in extractExternalCustomerId don't
// transitively bootstrap config + Postgres just for a substring slice.
export async function resolveCustomerComposite(
  builderId: string,
  customerId: string,
): Promise<string | null> {
  const [{ db }, { customers }] = await Promise.all([
    import('../db/client.js'),
    import('../db/schema.js'),
  ]);
  const rows = await db
    .select({ external_id: customers.external_id })
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.builder_id, builderId)))
    .limit(1);
  const r = rows[0];
  if (!r || !r.external_id) return null;
  return toCompositeCustomerId(builderId, r.external_id);
}
