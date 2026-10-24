import Link from 'next/link';
import { ArrowLeftIcon } from '@/components/icons';
import { buttonClasses } from '@/components/ui';
import { getTranslations } from '@/i18n/server';

export default async function PRNotFound() {
  const { dict } = await getTranslations();
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
        {dict.me.prs.notFound}
      </h1>
      <p className="mt-2 text-sm text-text-2">
        PR not found or you haven&apos;t contributed to it.
      </p>
      <Link href="/me/prs" className={buttonClasses('secondary', 'md', 'mt-6')}>
        <ArrowLeftIcon /> Back to Pull Requests
      </Link>
    </div>
  );
}
