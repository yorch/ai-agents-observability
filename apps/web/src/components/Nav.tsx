import type { User } from '@ai-agents-observability/db';
import { OrgRole } from '@ai-agents-observability/db';
import Link from 'next/link';

import { UserMenu } from './UserMenu';

export function Nav({ user }: { user: User | null }) {
  return (
    <nav className="flex items-center justify-between border-b border-white/10 px-6 py-3">
      <Link href="/" className="font-display text-sm font-semibold tracking-tight">
        ai-agents-observability
      </Link>
      <div className="flex items-center gap-4 text-sm">
        {user && user.orgRole !== OrgRole.member && (
          <Link href="/org/dashboard" className="text-white/60 hover:text-white hover:underline">
            Org
          </Link>
        )}
        {user ? (
          <UserMenu displayName={user.displayName ?? user.githubLogin ?? user.email ?? 'User'} />
        ) : (
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
        )}
      </div>
    </nav>
  );
}
