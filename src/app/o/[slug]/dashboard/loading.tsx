// Launch perf — generic dashboard tab skeleton. One file at the segment
// root covers every /dashboard/* navigation: the Suspense boundary it
// creates paints instantly on tab click while the destination page's
// server queries stream in.

import { SkeletonCard, SkeletonList, SkeletonPageHeader } from '@/components/dashboard/Skeleton';

export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Loading page">
      <span className="sr-only">Loading…</span>
      <SkeletonPageHeader />
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="mt-10">
        <SkeletonList rows={5} />
      </div>
    </div>
  );
}
