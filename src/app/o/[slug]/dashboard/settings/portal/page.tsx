// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.1 — portal management dashboard.

import type { Metadata } from 'next';
import { and, desc, eq } from 'drizzle-orm';
import { Role } from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { portalConfigs, portalLinks } from '@/lib/db/schema';
import { COPY } from '@/lib/copy';
import {
  PortalConfigClient,
  type PortalConfigRow,
  type PortalLinkRow,
} from '@/components/settings/PortalConfigClient';

export const metadata: Metadata = { title: 'Customer portal' };

export default async function PortalSettingsPage() {
  const { builderId, role } = await readDashboardHeaders();

  const [configRows, linkRows] = await Promise.all([
    withRLS(builderId, async (tx) =>
      tx.select().from(portalConfigs).where(eq(portalConfigs.builder_id, builderId)).limit(1),
    ),
    withRLS(builderId, async (tx) =>
      tx
        .select({
          id: portalLinks.id,
          customer_id: portalLinks.customer_id,
          jti: portalLinks.jti,
          link_type: portalLinks.link_type,
          status: portalLinks.status,
          expires_at: portalLinks.expires_at,
          revoked_at: portalLinks.revoked_at,
          created_at: portalLinks.created_at,
        })
        .from(portalLinks)
        .where(and(eq(portalLinks.builder_id, builderId)))
        .orderBy(desc(portalLinks.created_at))
        .limit(50),
    ),
  ]);

  const config: PortalConfigRow | null = configRows[0]
    ? {
        company_name: configRows[0].company_name,
        logo_url: configRows[0].logo_url,
        primary_color: configRows[0].primary_color,
        cost_display_mode: configRows[0].cost_display_mode,
        show_invoices: configRows[0].show_invoices,
        show_budget_progress: configRows[0].show_budget_progress,
        show_usage_trend: configRows[0].show_usage_trend,
        allowed_iframe_origins: configRows[0].allowed_iframe_origins,
      }
    : null;

  const links: PortalLinkRow[] = linkRows.map((r) => ({
    id: r.id,
    customer_id: r.customer_id,
    jti: r.jti,
    link_type: r.link_type,
    status: r.status,
    expires_at: r.expires_at.toISOString(),
    revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
  }));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.portal_page_title}</h1>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          {COPY.portal_page_subtitle}
        </p>
      </div>
      <div className="mt-6">
        <PortalConfigClient config={config} links={links} canMutate={role === Role.OWNER} />
      </div>
    </>
  );
}
