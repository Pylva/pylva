// Track 1 PR 1.4 — DLQ list endpoint.

import { NextResponse, type NextRequest } from 'next/server.js';
import { and, eq, desc } from 'drizzle-orm';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRLS } from '@/lib/db/rls';
import { webhookDlq } from '@/lib/db/schema';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const url = new URL(request.url);
  const channelFilter = url.searchParams.get('channel');
  const eventFilter = url.searchParams.get('event_type');

  // The channel / event_type filters MUST be applied in SQL, before the
  // 200-row cap — not in JS afterwards. Filtering after the limit means
  // the limit is taken over ALL channels first, so `?channel=slack`
  // returns only the slack rows that happen to fall within the newest 200
  // rows across every channel. A builder with >200 failed webhook
  // deliveries (older slack/email failures pushed past the cap) would see
  // an EMPTY slack list and conclude that channel is healthy, leaving dead
  // alerts un-retried and effectively dropped from the operator's view.
  // The idx_webhook_dlq_channel(channel, created_at) index exists exactly
  // to serve this filtered-and-ordered query.
  const conditions = [eq(webhookDlq.builder_id, ctx.builderId)];
  if (channelFilter) conditions.push(eq(webhookDlq.channel, channelFilter));
  if (eventFilter) conditions.push(eq(webhookDlq.event_type, eventFilter));

  const entries = await withRLS(ctx.builderId, async (tx) =>
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
      .where(and(...conditions))
      .orderBy(desc(webhookDlq.created_at))
      .limit(200),
  );

  return NextResponse.json({ entries });
}
