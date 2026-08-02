import { Card, SkeletonBar, SkeletonCard } from '@/components/ui';

export default function PRsLoading() {
  return (
    <div className="animate-pulse space-y-6">
      <SkeletonBar className="h-8 w-48" />

      <div className="grid grid-cols-3 gap-4">
        {[...Array(3)].map((_, i) => (
          <SkeletonCard key={i} className="h-20" />
        ))}
      </div>

      <div className="flex gap-3">
        <SkeletonBar className="h-9 w-36" />
        <SkeletonBar className="h-9 w-20" />
      </div>

      <Card flush>
        <div className="h-10 border-b border-border bg-surface-2" />
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="flex h-14 items-center gap-4 border-b border-border-subtle px-4 py-3 last:border-0"
          >
            <SkeletonBar className="h-4 w-48" />
            <SkeletonBar className="h-3 w-24" />
            <SkeletonBar className="ml-auto h-5 w-14 rounded-full" />
          </div>
        ))}
      </Card>
    </div>
  );
}
