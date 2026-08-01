import type { ReactNode } from 'react';

import '../styles/globals.css';

import { Rail, type RailTeam } from '@/components/shell/Rail';
import { ThemeToggle } from '@/components/ThemeToggle';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';
import { canRequestGrants } from '@/lib/roles';

export const metadata = {
  description: 'Self-hosted observability for AI coding agents.',
  title: 'ai-agents-observability',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  const canViewOrg = Boolean(user && user.orgRole !== 'MEMBER');

  let teams: RailTeam[] = [];
  if (user) {
    if (canViewOrg) {
      teams = await getPrisma().team.findMany({
        orderBy: { name: 'asc' },
        select: { githubSlug: true, name: true },
      });
    } else {
      const membership = await getPrisma().teamMember.findFirst({
        include: { team: { select: { githubSlug: true, name: true } } },
        orderBy: [{ roleInTeam: 'asc' }, { team: { name: 'asc' } }],
        where: { leftAt: null, userId: user.id },
      });
      teams = membership ? [membership.team] : [];
    }
  }

  return (
    <html lang="en">
      <head>
        {/* Applies the stored theme before first paint. Without it the page
            renders dark and then snaps to light on hydration. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('theme')==='light')document.documentElement.classList.add('light')}catch{}`,
          }}
        />
      </head>
      <body className="bg-bg font-body text-text">
        {user ? (
          // The rail owns navigation, so pages render straight into the canvas
          // with no section sub-nav above them.
          <div className="flex min-h-screen flex-col lg:flex-row">
            <Rail
              canViewOrg={canViewOrg}
              isAdmin={user.orgRole === 'ORG_ADMIN'}
              showGrants={canRequestGrants(user.orgRole)}
              teams={teams}
              userLabel={user.displayName ?? user.githubLogin ?? user.email ?? 'User'}
            />
            <main className="min-w-0 flex-1 px-5 py-7 lg:px-8">
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </main>
          </div>
        ) : (
          // Signed-out routes (login, install) get no rail, but the theme
          // toggle still has to be reachable — it is the only control that
          // sets `html.light`.
          <div className="flex min-h-screen flex-col">
            <div className="flex justify-end px-6 py-4">
              <ThemeToggle />
            </div>
            <main className="flex-1 px-6 pb-8">{children}</main>
          </div>
        )}
      </body>
    </html>
  );
}
