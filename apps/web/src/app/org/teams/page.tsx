import Link from 'next/link';

import { getPrisma } from '@/lib/prisma';
import { requireOrgViewer } from '@/lib/roles';
import { OrgSubNav } from '../layout';

export const dynamic = 'force-dynamic';

export default async function OrgTeamsPage() {
  await requireOrgViewer();

  const teams = await getPrisma().team.findMany({
    include: {
      _count: {
        select: { members: { where: { leftAt: null } } },
      },
    },
    orderBy: { name: 'asc' },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold text-white">Teams</h1>
        <p className="mt-1 text-sm text-white/50">{teams.length} teams in this organisation</p>
      </div>

      <OrgSubNav active="teams" />

      {teams.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center text-sm text-white/40">
          No teams configured yet
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <Link
              key={team.id}
              href={`/team/${team.githubSlug}`}
              className="group rounded-lg border border-white/10 bg-white/5 p-4 transition-colors hover:border-white/20 hover:bg-white/10"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-white group-hover:text-white">
                    {team.name}
                  </p>
                  <p className="mt-0.5 text-xs text-white/40">@{team.githubSlug}</p>
                </div>
                <span className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-xs font-mono text-white/60">
                  {team._count.members} member{team._count.members !== 1 ? 's' : ''}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
