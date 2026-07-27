// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — shared impl for the notify-pending-drafts cron.
//
// Finds every builder with draft invoices created within the last 7d and
// sends one aggregate Resend email to the org's Owner users. A single
// user who is Owner in multiple orgs gets ONE email with a per-org
// breakdown (per plan §5.4 edge case "Same user is Owner in multiple
// orgs with pending drafts").

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { builders, invoices, users, userBuilderMemberships } from '../db/schema.js';
import { env } from '../config.js';
import { logger } from '../logger.js';
import { authorizeBuilderCapability } from '../auth/builder-entitlement.js';
import { getBuilderEntitlementForShare } from '../db/advisory-locks.js';

const log = logger.child({ module: 'scripts.notify-pending-drafts' });

interface DraftsByBuilder {
  builder_id: string;
  draft_count: number;
}

interface OwnerTarget {
  user_id: string;
  email: string;
  drafts_by_builder: Map<string, number>;
}

export interface NotifyPendingDraftsResult {
  builders_with_drafts: number;
  skipped_builders_no_product_access: number;
  owners_notified: number;
  emails_sent: number;
  email_skipped_no_resend_key: boolean;
}

const NOTIFY_WINDOW_DAYS = 7;

async function draftCountsByBuilder(now: Date): Promise<DraftsByBuilder[]> {
  const since = new Date(now.getTime() - NOTIFY_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      builder_id: invoices.builder_id,
      draft_count: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .innerJoin(builders, eq(builders.id, invoices.builder_id))
    .where(
      and(
        eq(invoices.status, 'draft'),
        eq(builders.access_state, 'active'),
        gte(invoices.created_at, since),
      ),
    )
    .groupBy(invoices.builder_id);
  return rows as DraftsByBuilder[];
}

async function keepBuildersWithProductAccess(
  builderDrafts: DraftsByBuilder[],
): Promise<{ allowed: DraftsByBuilder[]; denied: number }> {
  const decisions = await Promise.all(
    builderDrafts.map(async (drafts) => ({
      drafts,
      decision: await authorizeBuilderCapability(drafts.builder_id, 'product'),
    })),
  );
  const allowed = decisions.filter(({ decision }) => decision.allowed).map(({ drafts }) => drafts);
  return { allowed, denied: decisions.length - allowed.length };
}

async function ownersForBuilders(builderIds: string[]): Promise<OwnerTarget[]> {
  if (builderIds.length === 0) return [];
  const rows = await db
    .select({
      user_id: userBuilderMemberships.user_id,
      email: users.email,
      builder_id: userBuilderMemberships.builder_id,
    })
    .from(userBuilderMemberships)
    .innerJoin(users, eq(users.id, userBuilderMemberships.user_id))
    .where(
      and(
        eq(userBuilderMemberships.role, 'owner'),
        inArray(userBuilderMemberships.builder_id, builderIds),
      ),
    );

  const byUser = new Map<string, OwnerTarget>();
  for (const r of rows) {
    const existing = byUser.get(r.user_id) ?? {
      user_id: r.user_id,
      email: r.email,
      drafts_by_builder: new Map<string, number>(),
    };
    existing.drafts_by_builder.set(r.builder_id, 0); // count filled in next step
    byUser.set(r.user_id, existing);
  }
  return Array.from(byUser.values());
}

function renderEmail(target: OwnerTarget): { subject: string; html: string } {
  const total = Array.from(target.drafts_by_builder.values()).reduce((a, b) => a + b, 0);
  const orgCount = target.drafts_by_builder.size;
  const subject =
    orgCount === 1
      ? `${total} draft invoice${total === 1 ? '' : 's'} awaiting review`
      : `${total} draft invoices across ${orgCount} orgs awaiting review`;
  const rows = Array.from(target.drafts_by_builder.entries())
    .map(
      ([builderId, count]) =>
        `<li><strong>${count}</strong> draft${count === 1 ? '' : 's'} in org ${builderId}</li>`,
    )
    .join('');
  const html = `<p>You have draft invoices awaiting review:</p><ul>${rows}</ul><p>Review them at <a href="${env.PYLVA_BACKEND_URL}/">Pylva</a>.</p>`;
  return { subject, html };
}

async function withLockedEligibleTarget<T>(
  target: OwnerTarget,
  callback: (eligibleTarget: OwnerTarget) => Promise<T>,
): Promise<T | null> {
  // Lock every workspace in a deterministic order before the external send.
  // This preserves the one-email/multi-org UX without introducing a
  // cross-builder deadlock when two owners share the same workspaces.
  const builderIds = [...target.drafts_by_builder.keys()].sort();
  return db.transaction(async (tx) => {
    const eligibleBuilderIds: string[] = [];
    for (const builderId of builderIds) {
      const resolution = await getBuilderEntitlementForShare(tx, builderId);
      if (
        resolution !== null &&
        resolution.ok &&
        resolution.entitlement.has_product_access
      ) {
        eligibleBuilderIds.push(builderId);
      }
    }
    if (eligibleBuilderIds.length === 0) return null;

    return callback({
      ...target,
      drafts_by_builder: new Map(
        eligibleBuilderIds.map((builderId) => [
          builderId,
          target.drafts_by_builder.get(builderId) ?? 0,
        ]),
      ),
    });
  });
}

export async function notifyPendingDrafts(opts: { now: Date }): Promise<NotifyPendingDraftsResult> {
  const now = opts.now;
  const discoveredDrafts = await draftCountsByBuilder(now);
  const access = await keepBuildersWithProductAccess(discoveredDrafts);
  const builderDrafts = access.allowed;

  if (builderDrafts.length === 0) {
    return {
      builders_with_drafts: 0,
      skipped_builders_no_product_access: access.denied,
      owners_notified: 0,
      emails_sent: 0,
      email_skipped_no_resend_key: false,
    };
  }

  const owners = await ownersForBuilders(builderDrafts.map((b) => b.builder_id));
  const countByBuilder = new Map(builderDrafts.map((b) => [b.builder_id, b.draft_count]));
  for (const o of owners) {
    for (const builderId of o.drafts_by_builder.keys()) {
      o.drafts_by_builder.set(builderId, countByBuilder.get(builderId) ?? 0);
    }
  }

  if (!env.RESEND_API_KEY) {
    return {
      builders_with_drafts: builderDrafts.length,
      skipped_builders_no_product_access: access.denied,
      owners_notified: owners.length,
      emails_sent: 0,
      email_skipped_no_resend_key: true,
    };
  }

  const { Resend } = await import('resend');
  const client = new Resend(env.RESEND_API_KEY);
  let sent = 0;
  let ownersNotified = 0;
  for (const target of owners) {
    try {
      const delivered = await withLockedEligibleTarget(target, async (eligibleTarget) => {
        const { subject, html } = renderEmail(eligibleTarget);
        await client.emails.send({
          from: env.ALERT_FROM_EMAIL ?? 'alerts@pylva.local',
          to: target.email,
          subject,
          html,
        });
        return true;
      });
      if (delivered) {
        ownersNotified += 1;
        sent += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ user_id: target.user_id, error: message }, 'draft notify email failed');
    }
  }

  return {
    builders_with_drafts: builderDrafts.length,
    skipped_builders_no_product_access: access.denied,
    owners_notified: ownersNotified,
    emails_sent: sent,
    email_skipped_no_resend_key: false,
  };
}
