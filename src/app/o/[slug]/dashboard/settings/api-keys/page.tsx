// Track 1 PR 1.2 — API key settings dashboard.
// Server component fetches metadata via RLS; renders the client form/list.

import type { Metadata } from 'next';
import { and, eq, isNull } from 'drizzle-orm';
import { Role } from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { apiKeys } from '@/lib/db/schema';
import { COPY } from '@/lib/copy';
import { ApiKeysClient, type KeyRow } from '@/components/settings/ApiKeysClient';

export const metadata: Metadata = { title: 'API keys' };

export default async function ApiKeysPage() {
  const { builderId, role } = await readDashboardHeaders();
  // One universal key (migration 048): scope is no longer projected — every
  // key has the same access, so there is nothing to display.
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({
        id: apiKeys.id,
        key_id: apiKeys.key_id,
        label: apiKeys.label,
        created_at: apiKeys.created_at,
        expires_at: apiKeys.expires_at,
        revoked_at: apiKeys.revoked_at,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.builder_id, builderId), isNull(apiKeys.revoked_at))),
  );

  const keys: KeyRow[] = rows.map((r) => ({
    id: r.id,
    key_id: r.key_id,
    label: r.label,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at ? r.expires_at.toISOString() : null,
    revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
  }));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.api_keys_page_title}</h1>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          {COPY.api_keys_page_subtitle}
        </p>
      </div>
      <div className="mt-6">
        <ApiKeysClient keys={keys} canMutate={role === Role.OWNER} />
      </div>
    </>
  );
}
