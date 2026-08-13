import { SkeletonBar, SkeletonCard } from '@/components/ui';

// Mirrors the shape shared by the org pages: title, stat row, two chart cards.
export default function OrgLoading() {
  return (
    <div className="animate-pulse motion-reduce:animate-none space-y-6">
      <SkeletonBar className="h-8 w-64" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <SkeletonCard key={i} className="h-24" />
        ))}
      </div>
      <SkeletonCard className="h-64" />
      <SkeletonCard className="h-64" />
    </div>
  );
}
