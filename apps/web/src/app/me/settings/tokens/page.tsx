import { redirect } from 'next/navigation';

import { TokenList } from '@/components/me/TokenList';
import { currentUser } from '@/lib/auth';
import { getPrisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export default async function SettingsTokensPage() {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const tokens = await getPrisma().authToken.findMany({
    orderBy: { createdAt: 'desc' },
    where: { kind: 'HOOK', userId: user.id },
  });

  return (
    <div className="space-y-8 max-w-lg">
      <div>
        <h2 className="font-display text-lg font-semibold text-text">Hook tokens</h2>
        <p className="mt-0.5 text-sm text-text-2">
          Manage tokens used by the <code className="font-mono">aiot</code> CLI to ingest telemetry.
          Revoking a token immediately stops the CLI from sending data.
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-text-2">Active tokens</h3>
        <TokenList
          tokens={tokens.map((t) => ({
            createdAt: t.createdAt.toISOString(),
            expiresAt: t.expiresAt?.toISOString() ?? null,
            id: t.id,
            revokedAt: t.revokedAt?.toISOString() ?? null,
          }))}
        />
      </section>
    </div>
  );
}
