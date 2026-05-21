import { redirect } from 'next/navigation';

import { currentUser } from '../../lib/auth.js';

export const dynamic = 'force-dynamic';

export default async function MePage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="font-display text-2xl font-semibold tracking-tight">
        Hello, {user.displayName ?? user.githubLogin}
      </h1>
      <p className="text-sm text-white/70">
        Your /me overview page will live here once P1-025 lands. For now this confirms
        the auth flow is end-to-end working.
      </p>
    </div>
  );
}
