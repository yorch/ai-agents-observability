import type { User } from '@ai-agents-observability/db';
import { OrgRole } from '@ai-agents-observability/db';
import Link from 'next/link';

import { TeamsDropdown } from './TeamsDropdown';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

type TeamEntry = { githubSlug: string; name: string };

export function Nav({
  allTeams,
  ledTeam,
  user,
}: {
  allTeams: TeamEntry[];
  ledTeam: TeamEntry | null;
  user: User | null;
}) {
  const isAdmin = user?.orgRole === OrgRole.ORG_ADMIN;
  const canViewOrg = user && user.orgRole !== OrgRole.MEMBER;

  return (
    <nav className="flex items-center justify-between border-b border-border px-6 py-4">
      <Link
        href="/"
        className="font-display text-sm font-semibold tracking-tight text-text hover:text-accent transition-colors"
      >
        ai-agents-observability
      </Link>

      <div className="flex items-center gap-5 text-sm">
        {user && (
          <Link href="/me" className="text-text-2 hover:text-text transition-colors">
            My Agents
          </Link>
        )}
        {ledTeam && !canViewOrg && (
          <Link
            href={`/team/${ledTeam.githubSlug}`}
            className="text-text-2 hover:text-text transition-colors"
          >
            {ledTeam.name}
          </Link>
        )}
        {allTeams.length > 0 && <TeamsDropdown teams={allTeams} />}
        {canViewOrg && (
          <Link href="/org/dashboard" className="text-text-2 hover:text-text transition-colors">
            Org
          </Link>
        )}
        {isAdmin && (
          <Link href="/admin" className="text-text-2 hover:text-text transition-colors">
            Admin
          </Link>
        )}

        {user ? (
          <UserMenu displayName={user.displayName ?? user.githubLogin ?? user.email ?? 'User'} />
        ) : (
          <Link href="/login" className="text-text-2 hover:text-text transition-colors">
            Sign in
          </Link>
        )}

        <ThemeToggle />
      </div>
    </nav>
  );
}
