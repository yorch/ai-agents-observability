import { DM_Sans, IBM_Plex_Mono, Syne } from 'next/font/google';
import type { ReactNode } from 'react';

import '../styles/globals.css';

import { TeamRole } from '@ai-agents-observability/db';
import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

const syne = Syne({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-syne',
  weight: ['400', '500', '600', '700', '800'],
});

const dmSans = DM_Sans({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-dm-sans',
});

const ibmMono = IBM_Plex_Mono({
  display: 'swap',
  subsets: ['latin'],
  variable: '--font-ibm-mono',
  weight: ['400', '500', '600'],
});

export const metadata = {
  description: 'Self-hosted observability for AI coding agents.',
  title: 'ai-agents-observability',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();

  let ledTeam: { githubSlug: string; name: string } | null = null;
  if (user) {
    const membership = await getPrisma().teamMember.findFirst({
      include: { team: { select: { githubSlug: true, name: true } } },
      where: {
        leftAt: null,
        roleInTeam: { in: [TeamRole.LEAD, TeamRole.MAINTAINER] },
        userId: user.id,
      },
    });
    ledTeam = membership?.team ?? null;
  }

  return (
    <html lang="en" className={`${syne.variable} ${dmSans.variable} ${ibmMono.variable}`}>
      <body className="flex min-h-screen flex-col font-body bg-bg text-text">
        <Nav ledTeam={ledTeam} user={user} />
        <main className="flex-1 px-6 py-8">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
