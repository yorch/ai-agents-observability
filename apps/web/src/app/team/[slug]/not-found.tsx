import Link from 'next/link';
import { buttonClasses } from '@/components/ui';
import { getTranslations } from '@/i18n/server';

export default async function TeamNotFound() {
  const { dict } = await getTranslations();
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="text-4xl font-semibold text-text-3">404</p>
      <p className="mt-3 text-lg font-medium">{dict.team.notFound}</p>
      <p className="mt-1 text-sm text-text-2">
        This team doesn't exist or you don't have access to it.
      </p>
      <Link href="/me" className={buttonClasses('secondary', 'md', 'mt-6')}>
        Back to My Agents
      </Link>
    </div>
  );
}
