import { SkeletonCard } from '@/components/ui';

export default function MeLoading() {
  return (
    <div className="animate-pulse motion-reduce:animate-none space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <SkeletonCard key={i} className="h-24" />
        ))}
      </div>
      <SkeletonCard className="h-48" />
      <SkeletonCard className="h-64" />
    </div>
  );
}
