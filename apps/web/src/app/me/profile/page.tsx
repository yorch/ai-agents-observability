import { redirect } from 'next/navigation';
import { ProfileForm } from '@/components/me/ProfileForm';
import { currentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="mt-1 text-sm text-white/50">
          Update your display name and email address.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-white/70">Account information</h2>
        <ProfileForm
          initialDisplayName={user.displayName}
          initialEmail={user.email}
          githubLogin={user.githubLogin}
        />
      </section>
    </div>
  );
}
