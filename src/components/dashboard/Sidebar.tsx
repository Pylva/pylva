// B2a T1 — dashboard left nav. Links are slug-prefixed (D7).

import { COPY } from '@/lib/copy';
import { cn } from '@/lib/utils';

interface NavItem {
  href: (slug: string) => string;
  label: string;
  deferred?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

// Frontend launch §4 — grouped sidebar: Observe / React / Bill / Configure.
const NAV: NavGroup[] = [
  {
    title: 'Observe',
    items: [
      { href: (s) => `/o/${s}/dashboard`, label: COPY.nav_overview },
      { href: (s) => `/o/${s}/dashboard/end-users`, label: COPY.nav_end_users },
      { href: (s) => `/o/${s}/dashboard/models`, label: COPY.nav_models },
      {
        href: (s) => `/o/${s}/dashboard/budget-activity`,
        label: COPY.nav_budget_activity,
      },
    ],
  },
  {
    title: 'React',
    items: [
      { href: (s) => `/o/${s}/dashboard/rules`, label: COPY.nav_rules },
      { href: (s) => `/o/${s}/dashboard/simulator`, label: COPY.nav_simulator },
    ],
  },
  {
    title: 'Bill',
    items: [
      { href: (s) => `/o/${s}/dashboard/billing`, label: COPY.nav_billing },
      { href: (s) => `/o/${s}/dashboard/cost-sources`, label: COPY.nav_cost_sources },
    ],
  },
  {
    title: 'Configure',
    items: [{ href: (s) => `/o/${s}/dashboard/settings`, label: COPY.nav_settings }],
  },
];

export function Sidebar({ pathname, slug }: { pathname: string; slug: string }) {
  return (
    <aside className="hidden w-56 shrink-0 border-r border-[color:var(--border)] bg-[color:var(--card)] p-4 md:block">
      <a
        href={`/o/${slug}/dashboard`}
        className="mb-7 flex items-center gap-2 font-semibold tracking-tight"
      >
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[color:var(--primary)] text-[color:var(--primary-foreground)]"
          aria-hidden
        >
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none">
            <path
              d="M2 10.5 5 4.5l2 3 4-6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span>Pylva</span>
      </a>
      <nav className="flex flex-col gap-5 text-sm" aria-label="Dashboard">
        {NAV.map((group) => (
          <div key={group.title}>
            <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider app-muted">
              {group.title}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const href = item.href(slug);
                const active = pathname === href;
                return (
                  <a
                    key={href}
                    href={href}
                    className={cn(
                      'rounded-md px-3 py-1.5 transition-colors',
                      active
                        ? 'bg-[color:var(--primary)] text-[color:var(--primary-foreground)]'
                        : 'text-[color:var(--foreground)] hover:bg-[color:var(--accent)]',
                      item.deferred && !active ? 'opacity-60' : '',
                    )}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}
