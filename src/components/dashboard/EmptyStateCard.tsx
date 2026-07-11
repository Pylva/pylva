// Shared empty / 404 / "missing param" card. Same dashed-border framing
// used across overview, simulator, and cost-sources pages so the UX stays
// consistent when there's nothing to render.

import type { ReactNode } from 'react';

interface EmptyStateCardProps {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  variant?: 'default' | 'dashed';
}

export function EmptyStateCard({
  title,
  body,
  action,
  variant = 'default',
}: EmptyStateCardProps): React.ReactElement {
  const borderClass = variant === 'dashed' ? 'border-dashed' : '';
  return (
    <div className={`mt-8 app-card ${borderClass} p-8 text-center`}>
      <p className="text-sm font-medium">{title}</p>
      {body ? (
        <div className="mt-2 text-sm text-[color:var(--muted-foreground)]">{body}</div>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
