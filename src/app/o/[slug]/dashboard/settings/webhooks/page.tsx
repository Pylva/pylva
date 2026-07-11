// Track 1 PR 1.3 — webhook settings dashboard.

import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { Role } from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { webhookConfigs } from '@/lib/db/schema';
import { COPY } from '@/lib/copy';
import { WebhooksClient, type WebhookRow } from '@/components/settings/WebhooksClient';

export const metadata: Metadata = { title: 'Webhooks' };

export default async function WebhooksPage() {
  const { builderId, role } = await readDashboardHeaders();
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({
        id: webhookConfigs.id,
        url: webhookConfigs.url,
        events: webhookConfigs.events,
        enabled: webhookConfigs.enabled,
        secret_rotated_at: webhookConfigs.secret_rotated_at,
        created_at: webhookConfigs.created_at,
        updated_at: webhookConfigs.updated_at,
      })
      .from(webhookConfigs)
      .where(eq(webhookConfigs.builder_id, builderId)),
  );

  const webhooks: WebhookRow[] = rows.map((r) => ({
    id: r.id,
    url: r.url,
    events: r.events,
    enabled: r.enabled,
    secret_rotated_at: r.secret_rotated_at ? r.secret_rotated_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.webhooks_page_title}</h1>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          {COPY.webhooks_page_subtitle}
        </p>
      </div>
      <div className="mt-6">
        <WebhooksClient webhooks={webhooks} canMutate={role === Role.OWNER} />
      </div>
    </>
  );
}
