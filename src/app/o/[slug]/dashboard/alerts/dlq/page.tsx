// Track 1 PR 1.4 — DLQ dashboard.

import type { Metadata } from 'next';
import { eq, desc } from 'drizzle-orm';
import { Role } from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { webhookDlq } from '@/lib/db/schema';
import { COPY } from '@/lib/copy';
import { DlqTable, type DlqRow } from '@/components/alerts/DlqTable';

export const metadata: Metadata = { title: 'Dead-letter queue' };

export default async function DlqPage() {
  const { builderId, role } = await readDashboardHeaders();
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select({
        id: webhookDlq.id,
        channel: webhookDlq.channel,
        event_type: webhookDlq.event_type,
        webhook_config_id: webhookDlq.webhook_config_id,
        attempts: webhookDlq.attempts,
        last_attempt_at: webhookDlq.last_attempt_at,
        last_error: webhookDlq.last_error,
        created_at: webhookDlq.created_at,
      })
      .from(webhookDlq)
      .where(eq(webhookDlq.builder_id, builderId))
      .orderBy(desc(webhookDlq.created_at))
      .limit(200),
  );

  const entries: DlqRow[] = rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    event_type: r.event_type,
    webhook_config_id: r.webhook_config_id,
    attempts: r.attempts,
    last_attempt_at: r.last_attempt_at ? r.last_attempt_at.toISOString() : null,
    last_error: r.last_error,
    created_at: r.created_at.toISOString(),
  }));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.dlq_page_title}</h1>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          {COPY.dlq_page_subtitle}
        </p>
      </div>
      <div className="mt-6">
        <DlqTable entries={entries} canRetry={role === Role.OWNER} />
      </div>
    </>
  );
}
