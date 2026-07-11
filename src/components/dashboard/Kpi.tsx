// Shared KPI tile shell. Renders a label + value/children inside the standard
// dashboard card frame. Consumers pass either a string `value` (static page)
// or a `children` element (live-updating LiveCounter). Used by the overview
// page and the LiveCostFeed live-update wrapper.

import type { ReactNode } from 'react';

interface KpiProps {
  label: string;
  value?: string;
  children?: ReactNode;
}

export function Kpi({ label, value, children }: KpiProps): React.ReactElement {
  return (
    <div className="app-card p-6">
      <div className="text-xs uppercase tracking-wider app-muted">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums">{children ?? value ?? null}</div>
    </div>
  );
}
