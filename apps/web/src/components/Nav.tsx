import type { User } from '@ai-agents-observability/db';
import { OrgRole } from '@ai-agents-observability/db';
import Link from 'next/link';

import { UserMenu } from './UserMenu';

type LedTeam = { githubSlug: string; name: string };

export function Nav({ user, ledTeam }: { ledTeam: LedTeam | null; user: User | null }) {
  const isAdmin = user?.orgRole === OrgRole.ORG_ADMIN;
  const canViewOrg = user && user.orgRole !== OrgRole.MEMBER;

  return (
    <nav className="flex items-center justify-between border-b border-white/10 px-6 py-3">
      <Link href="/" className="font-display text-sm font-semibold tracking-tight">
        ai-agents-observability
      </Link>
      <div className="flex items-center gap-4 text-sm">
        {isAdmin && (
          <Link href="/admin/jobs" className="text-white/60 hover:text-white hover:underline">
            Admin
          </Link>
        )}
        {ledTeam && (
          <Link
            href={`/team/${ledTeam.githubSlug}`}
            className="text-white/60 hover:text-white hover:underline"
          >
            {ledTeam.name}
          </Link>
        )}
        {canViewOrg && (
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
