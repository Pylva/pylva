import { Skeleton } from '@/components/dashboard/Skeleton';

export default function BudgetActivityLoading() {
  return (
    <div role="status" aria-label="Loading budget activity">
      <Skeleton className="h-8 w-52" />
      <Skeleton className="mt-2 h-4 w-full max-w-2xl" />
      <Skeleton className="mt-8 h-40 w-full" />
      <Skeleton className="mt-4 h-72 w-full" />
    </div>
  );
}
