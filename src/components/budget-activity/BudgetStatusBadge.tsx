import type { BudgetActivityStatus } from '@/lib/budget-activity/types';

const PRESENTATION: Record<
  BudgetActivityStatus,
  { glyph: string; label: string; className: string }
> = {
  reserved: {
    glyph: '◷',
    label: 'Reserved',
    className:
      'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  },
  charged: {
    glyph: '✓',
    label: 'Charged',
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  },
  released: {
    glyph: '↩',
    label: 'Released',
    className:
      'border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200',
  },
  unresolved: {
    glyph: '!',
    label: 'Unresolved',
    className:
      'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  },
  refused: {
    glyph: '⊘',
    label: 'Refused',
    className:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
  },
};

export function BudgetStatusBadge({ status }: { status: BudgetActivityStatus }) {
  const presentation = PRESENTATION[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium ${presentation.className}`}
      aria-label={`Budget status: ${presentation.label}`}
    >
      <span aria-hidden>{presentation.glyph}</span>
      {presentation.label}
    </span>
  );
}
