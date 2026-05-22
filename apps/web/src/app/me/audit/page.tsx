import { redirect } from 'next/navigation';

import { currentUser } from '../../../lib/auth';
import { getPrisma } from '../../../lib/prisma';
import { AuditTable } from '../../../components/me/AuditTable';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type SearchParams = { page?: string };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) redirect('/login');

  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? '1', 10));

  const prisma = getPrisma();

  const where = {
    OR: [{ actorUserId: user.id }, { targetUserId: user.id }],
  };

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      orderBy: { ts: 'desc' },
      select: {
        action: true,
        actorUserId: true,
        id: true,
        ip: true,
        justification: true,
        targetSessionId: true,
        targetTeamId: true,
        targetUserId: true,
        ts: true,
      },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      where,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="mt-1 text-sm text-white/50">
          Records of when your data was accessed by you or team/org members.
        </p>
      </div>

      <AuditTable rows={rows} total={total} currentPage={page} />
    </div>
  );
}
