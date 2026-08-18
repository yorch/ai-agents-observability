import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/icons';
import { buttonClasses } from '@/components/ui';

/**
 * Root 404 — catches every notFound() without a closer boundary, which
 * previously fell through to Next's unthemed default page.
 */
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
        Page not found
      </h1>
      <p className="mt-2 text-sm text-text-2">
        This page doesn&apos;t exist, or you don&apos;t have access to it.
      </p>
      <Link href="/" className={buttonClasses('secondary', 'md', 'mt-6')}>
        <ArrowLeftIcon /> Back to overview
      </Link>
    </div>
  );
}
