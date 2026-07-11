// v2 — audit-log dashboard (O13).
// Owner-only — middleware enforces, the API route double-checks.

import type { Metadata } from 'next';
import { Role } from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { COPY } from '@/lib/copy';
import { AuditLogClient } from '@/components/settings/AuditLogClient';

export const metadata: Metadata = { title: 'Audit log' };

export default async function AuditLogPage() {
  const { role } = await readDashboardHeaders();

  if (role !== Role.OWNER) {
    return (
      <>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{COPY.audit_log_page_title}</h1>
        </div>
        <p className="mt-6 text-sm text-[color:var(--muted-foreground)]">
          {COPY.audit_log_member_blocked}
        </p>
      </>
    );
  }

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{COPY.audit_log_page_title}</h1>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          {COPY.audit_log_page_subtitle}
        </p>
      </div>
      <div className="mt-6">
        <AuditLogClient />
      </div>
    </>
  );
}
