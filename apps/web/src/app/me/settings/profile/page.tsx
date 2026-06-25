import { redirect } from 'next/navigation';
import { ProfileForm } from '@/components/me/ProfileForm';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function SettingsProfilePage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h2 className="text-lg font-semibold">Profile</h2>
        <p className="mt-0.5 text-sm text-text-2">Update your display name and email address.</p>
      </div>
      <ProfileForm
        initialDisplayName={user.displayName}
        initialEmail={user.email}
        githubLogin={user.githubLogin}
      />
    </div>
  );
}
