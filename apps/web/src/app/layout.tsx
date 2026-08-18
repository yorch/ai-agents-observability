import localFont from 'next/font/local';
import type { ReactNode } from 'react';

import '../styles/globals.css';

// globals.css maps --font-display/body/mono onto these variables. The files
// are vendored (src/fonts/README.md) so `next build` needs no network — the
// Google-hosted variant made every Docker build depend on fonts.googleapis.com.
const syne = localFont({ src: '../fonts/syne-700.woff2', variable: '--font-syne', weight: '700' });
const dmSans = localFont({
  src: '../fonts/dm-sans.woff2',
  variable: '--font-dm-sans',
  weight: '400 500',
});
const ibmMono = localFont({
  src: [
    { path: '../fonts/ibm-plex-mono-400.woff2', weight: '400' },
    { path: '../fonts/ibm-plex-mono-500.woff2', weight: '500' },
  ],
  variable: '--font-ibm-mono',
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
        {/* First tab stop on every page — the rail is ~20 links deep. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-accent-line focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-text"
        >
          Skip to content
        </a>
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
            <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-5 py-7 outline-none lg:px-8">
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
            <main id="main" tabIndex={-1} className="flex-1 px-6 pb-8 outline-none">
              {children}
            </main>
          </div>
        )}
      </body>
    </html>
  );
}
