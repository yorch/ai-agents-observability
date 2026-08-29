import { redirect } from 'next/navigation';
import { ProfileForm } from '@/components/me/ProfileForm';
import { getTranslations } from '@/i18n/server';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsProfilePage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const { dict } = await getTranslations();
  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="font-display text-lg font-semibold text-text">
          {dict.me.settings.profile.title}
        </h2>
        <p className="mt-0.5 text-sm text-text-2">{dict.me.settings.profile.description}</p>
      </div>
      <ProfileForm
        initialDisplayName={user.displayName}
        initialEmail={user.email}
        githubLogin={user.githubLogin}
      />
    </div>
  );
}
