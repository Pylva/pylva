// B2a T1 — settings hub. Links to team / api-keys / webhooks / billing
// (billing is a B2b-populated placeholder).

import type { Metadata } from 'next';
import { PageHeader } from '@/components/dashboard/PageHeader';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const base = `/o/${slug}/dashboard/settings`;
  const sections: Array<{ href: string; title: string; body: string; deferred?: boolean }> = [
    { href: `${base}/team`, title: 'Team', body: 'Invite teammates and manage roles.' },
    {
      href: `${base}/api-keys`,
      title: 'API keys',
      body: 'Create Agent SDK, Admin API, and Data import keys.',
    },
    { href: `${base}/webhooks`, title: 'Webhooks', body: 'Delivery endpoints + HMAC secrets.' },
    {
      href: `${base}/portal`,
      title: 'Customer portal',
      body: 'Branding, allowed iframe origins, and per-customer access links.',
    },
    {
      href: `${base}/billing`,
      title: 'Billing',
      body: 'Stripe Connect + payment-failure alert channel.',
    },
    {
      href: `${base}/audit-log`,
      title: 'Audit log',
      body: 'Every owner / billing / security mutation. Owner-only.',
    },
  ];

  return (
    <>
      <PageHeader title="Settings" description="Configure your org." />

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <a
            key={s.href}
            href={s.deferred ? '#' : s.href}
            className={`app-card p-6 ${s.deferred ? 'opacity-60 pointer-events-none' : 'hover:border-[color:var(--primary)]'}`}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{s.title}</h2>
              {s.deferred ? (
                <span className="rounded-sm bg-[color:var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                  soon
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">{s.body}</p>
          </a>
        ))}
      </div>
    </>
  );
}
