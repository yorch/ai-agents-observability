import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/icons';

export default function PRNotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h1 className="text-2xl font-semibold">PR not found</h1>
      <p className="mt-2 text-sm text-white/50">
        PR not found or you haven&apos;t contributed to it.
      </p>
      <Link
        href="/me/prs"
        className="mt-6 inline-flex items-center gap-1 rounded-md border border-white/10 px-4 py-2 text-sm hover:bg-white/10 transition-colors"
      >
        <ArrowLeftIcon /> Back to Pull Requests
      </Link>
    </div>
  );
}
