// Health status badge for the cost-sources list. Server-renderable (pure
// markup); the tooltip is plain `title` so it works without a JS bundle.

import { CostSourceStatus, type CostSourceStatus as Status } from '@pylva/shared';

interface BadgeStyle {
  dotClass: string;
  textClass: string;
  label: string;
  tooltip: string;
}

const STYLES: Record<Status, BadgeStyle> = {
  [CostSourceStatus.HEALTHY]: {
    dotClass: 'bg-emerald-500',
    textClass: 'text-emerald-700',
    label: 'Healthy',
    tooltip: 'Source is reporting events on its expected cadence',
  },
  [CostSourceStatus.WARNING]: {
    dotClass: 'bg-amber-500',
    textClass: 'text-amber-700',
    label: 'Warning',
    tooltip: 'Adaptive silence threshold exceeded or 7d cost dropped >90% vs 30d',
  },
  [CostSourceStatus.BROKEN]: {
    dotClass: 'bg-red-500',
    textClass: 'text-red-700',
    label: 'Broken',
    tooltip: 'Source has been silent for >72h — instrumentation likely down',
  },
};

export function SourceHealthBadge({ status }: { status: Status }): React.ReactElement {
  const style = STYLES[status] ?? STYLES[CostSourceStatus.HEALTHY];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--muted)] px-2.5 py-0.5 text-xs"
      title={style.tooltip}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dotClass}`} aria-hidden />
      <span className={style.textClass}>{style.label}</span>
    </span>
  );
}
