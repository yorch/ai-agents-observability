import { SkeletonBar } from '@/components/ui';

export default function Loading() {
  return (
    <div className="mx-auto max-w-md py-16">
      <SkeletonBar className="h-4 w-32" />
    </div>
  );
}
