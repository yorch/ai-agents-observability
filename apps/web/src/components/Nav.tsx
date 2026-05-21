import Link from 'next/link';
import type { User } from '@ai-agents-observability/db';

import { UserMenu } from './UserMenu.js';

export function Nav({ user }: { user: User | null }) {
  return (
    <nav className="flex items-center justify-between border-b border-white/10 px-6 py-3">
      <Link href="/" className="font-display text-sm font-semibold tracking-tight">
        ai-agents-observability
      </Link>
      <div className="flex items-center gap-4 text-sm">
        {user ? (
          <UserMenu displayName={user.displayName ?? user.githubLogin} />
        ) : (
          <Link href="/login" className="hover:underline">
            Sign in
          </Link>
        )}
      </div>
    </nav>
  );
}
