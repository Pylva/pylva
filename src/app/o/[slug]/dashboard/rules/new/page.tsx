// B2a T3 — template gallery (D27). 3 starter templates + custom request
// button. Clicking a template jumps straight to /rules/new/[type] with
// pre-filled defaults; custom opens a concierge request form.

import type { Metadata } from 'next';
import { COPY } from '@/lib/copy';

export const metadata: Metadata = { title: 'New rule' };

interface Template {
  href: (slug: string) => string;
  title: string;
  body: string;
  preview: boolean;
}

const TEMPLATES: Template[] = [
  {
    href: (s) => `/o/${s}/dashboard/rules/new/budget_limit`,
    title: COPY.rule_template_budget,
    body: 'Hard-stop an end-user when they exceed a daily spend cap. Enforced pre-call by the SDK.',
    preview: false,
  },
  {
    href: (s) => `/o/${s}/dashboard/rules/new/cost_threshold`,
    title: COPY.rule_template_threshold,
    body: 'Alert when spend crosses a value in a given period. Post-call evaluation.',
    preview: false,
  },
  {
    href: (s) => `/o/${s}/dashboard/rules/new/margin_protection`,
    title: COPY.rule_template_margin,
    body: 'Watch for negative margin and surface the top cost drivers. Preview — B6 expands this.',
    preview: true,
  },
];

export default async function NewRulePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">New rule</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        Pick a starter template, or request something custom.
      </p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {TEMPLATES.map((t) => (
          <a
            key={t.title}
            href={t.href(slug)}
            className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6 hover:border-[color:var(--primary)]"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">{t.title}</h2>
              {t.preview ? (
                <span className="rounded-sm bg-[color:var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                  preview
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">{t.body}</p>
          </a>
        ))}
        <a
          href={`/o/${slug}/dashboard/rules/new/custom`}
          className="rounded-lg border border-dashed border-[color:var(--border)] bg-[color:var(--background)] p-6 hover:border-[color:var(--primary)]"
        >
          <h2 className="text-base font-semibold">{COPY.rule_custom}</h2>
          <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
            Tell us what you want the rule to do. We&apos;ll attach your workspace details.
          </p>
        </a>
      </div>
    </>
  );
}
