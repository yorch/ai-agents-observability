import type { ReactNode } from 'react';

import '../styles/globals.css';

import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';
import { currentUser } from '@/lib/auth';

export const metadata = {
  description: 'Self-hosted observability for AI coding agents.',
  title: 'ai-agents-observability',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col font-display">
        <Nav user={user} />
        <main className="flex-1 px-6 py-8">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
