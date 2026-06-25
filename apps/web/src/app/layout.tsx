import type { ReactNode } from 'react';

import '../styles/globals.css';

import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

export const metadata = {
  description: 'Self-hosted observability for AI coding agents.',
  title: 'ai-agents-observability',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();

  const canViewOrg = user && user.orgRole !== 'MEMBER';

  let ledTeam: { githubSlug: string; name: string } | null = null;
  let allTeams: { githubSlug: string; name: string }[] = [];

  if (user) {
    if (canViewOrg) {
      allTeams = await getPrisma().team.findMany({
        orderBy: { name: 'asc' },
        select: { githubSlug: true, name: true },
      });
    } else {
      const membership = await getPrisma().teamMember.findFirst({
        include: { team: { select: { githubSlug: true, name: true } } },
        orderBy: [{ roleInTeam: 'asc' }, { team: { name: 'asc' } }],
        where: { leftAt: null, userId: user.id },
      });
      ledTeam = membership?.team ?? null;
    }
  }

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col font-body bg-bg text-text">
        <Nav allTeams={allTeams} ledTeam={ledTeam} user={user} />
        <main className="flex-1 px-6 py-8">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
