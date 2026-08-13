import { DM_Sans, IBM_Plex_Mono, Syne } from 'next/font/google';
import type { ReactNode } from 'react';

import '../styles/globals.css';

// globals.css maps --font-display/body/mono onto these variables; the weights
// mirror the type ramp (Syne 700 display, DM Sans 400/500 UI, Plex Mono 400/500 data).
const syne = Syne({ subsets: ['latin'], variable: '--font-syne', weight: ['700'] });
const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans', weight: ['400', '500'] });
const ibmMono = IBM_Plex_Mono({
  subsets: ['latin'],
  variable: '--font-ibm-mono',
  weight: ['400', '500'],
});

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
        // Bounded: this list ships in the RSC payload of every page, and is
        // only read by the rail's team picker.
        take: 100,
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
    <html lang="en" className={`${syne.variable} ${dmSans.variable} ${ibmMono.variable}`}>
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
