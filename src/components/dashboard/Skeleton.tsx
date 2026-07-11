// Launch perf — loading-state primitives for dashboard route segments.
// Mirrors PageHeader / Kpi / list-row proportions so skeletons swap 1:1
// with real content. Semantic tokens only (--muted / --border): a surface
// re-skin retints these with zero edits here.

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div aria-hidden className={`animate-pulse rounded-md bg-[color:var(--muted)] ${className}`} />
  );
}

export function SkeletonPageHeader() {
  return (
    <div className="mb-8" aria-hidden>
      <Skeleton className="h-8 w-44" />
      <Skeleton className="mt-2 h-4 w-72 max-w-full" />
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="app-card p-6" aria-hidden>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-32" />
    </div>
  );
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
