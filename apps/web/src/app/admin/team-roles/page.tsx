import { getPrisma } from '@/lib/prisma';
import { LEAD_ROLES, requireOrgAdmin } from '@/lib/roles';

import { setTeamRole } from './actions';

export const dynamic = 'force-dynamic';

export default async function TeamRolesAdminPage() {
  await requireOrgAdmin();

  const db = getPrisma();
  const teams = await db.team.findMany({
    include: {
      members: {
        include: { user: { select: { displayName: true, githubLogin: true, id: true } } },
        orderBy: { roleInTeam: 'asc' },
        where: { leftAt: null },
      },
    },
    orderBy: { name: 'asc' },
  });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Team roles</h1>
        <p className="text-sm text-white/50">
          Grant or revoke team-lead access. Leads can view their team&apos;s sessions and cost.
          Access is assigned explicitly here — it is never inferred from GitHub team roles.
        </p>
      </div>

      {teams.length === 0 && <p className="text-sm text-white/40">No teams synced yet.</p>}

      <div className="space-y-8">
        {teams.map((team) => (
          <section key={team.id} className="space-y-2">
            <h2 className="text-sm font-medium text-white/80">
              {team.name} <span className="text-white/30">{team.githubSlug}</span>
            </h2>
            {team.members.length === 0 ? (
              <p className="text-xs text-white/30">No active members.</p>
            ) : (
              <ul className="divide-y divide-white/5 rounded-lg border border-white/10 bg-white/5">
                {team.members.map((m) => {
                  const isLead = LEAD_ROLES.includes(m.roleInTeam);
                  const name = m.user.displayName ?? `@${m.user.githubLogin ?? m.user.id}`;
                  return (
                    <li
                      key={m.userId}
                      className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-white/80">{name}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            isLead ? 'bg-brand-500/20 text-brand-300' : 'bg-white/10 text-white/40'
                          }`}
                        >
                          {m.roleInTeam}
                        </span>
                      </div>
                      <form action={setTeamRole}>
                        <input type="hidden" name="teamId" value={team.id} />
                        <input type="hidden" name="userId" value={m.userId} />
                        <input type="hidden" name="role" value={isLead ? 'member' : 'lead'} />
                        <button
                          type="submit"
                          className="rounded-md border border-white/10 px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/10"
                        >
                          {isLead ? 'Revoke lead' : 'Make lead'}
                        </button>
                      </form>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
