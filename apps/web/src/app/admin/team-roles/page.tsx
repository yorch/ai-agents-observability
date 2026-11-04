import { TeamRole } from '@ai-agents-observability/db';
import { ActionForm, Button, Card, CardEmpty, ConfirmButton, PageHeader } from '@/components/ui';
import { cx } from '@/components/ui/cx';
import { getPrisma } from '@/lib/prisma';
import { LEAD_ROLES, requireOrgAdmin } from '@/lib/roles';

import { setTeamRole } from './actions';

export const dynamic = 'force-dynamic';

const TEAM_ROLE_LABEL: Record<TeamRole, { description: string; label: string }> = {
  [TeamRole.MEMBER]: {
    description: 'Contributes to the team. Cannot open team views.',
    label: 'Member',
  },
  [TeamRole.LEAD]: {
    description: "Can view the team's sessions and cost.",
    label: 'Lead',
  },
  [TeamRole.MAINTAINER]: {
    description: 'Same access as a lead.',
    label: 'Maintainer',
  },
};

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
      <PageHeader
        breadcrumb="Admin"
        title="Team roles"
        description="Grant or revoke team-lead access. Access is assigned explicitly here — it is never inferred from GitHub team roles."
      />

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        {Object.values(TeamRole).map((r) => (
          <div key={r} className="contents">
            <dt className="font-medium text-text">{TEAM_ROLE_LABEL[r].label}</dt>
            <dd className="text-text-2">{TEAM_ROLE_LABEL[r].description}</dd>
          </div>
        ))}
      </dl>

      {teams.length === 0 && <p className="text-sm text-text-3">No teams synced yet.</p>}

      <div className="space-y-8">
        {teams.map((team) => (
          <section key={team.id} className="space-y-2">
            <h2 className="text-sm font-medium text-text">
              {team.name} <span className="text-text-3">{team.githubSlug}</span>
            </h2>
            {team.members.length === 0 ? (
              <Card>
                <CardEmpty>No active members.</CardEmpty>
              </Card>
            ) : (
              <Card flush>
                <ul className="divide-y divide-border-subtle">
                  {team.members.map((m) => {
                    const isLead = LEAD_ROLES.includes(m.roleInTeam);
                    const name = m.user.displayName ?? `@${m.user.githubLogin ?? m.user.id}`;
                    return (
                      <li
                        key={m.userId}
                        className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                      >
                        <div className="flex items-center gap-3">
                          <span className="text-text">{name}</span>
                          <span
                            className={cx(
                              'rounded px-1.5 py-0.5 text-xs',
                              isLead ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-text-3',
                            )}
                          >
                            {TEAM_ROLE_LABEL[m.roleInTeam].label}
                          </span>
                        </div>
                        <ActionForm action={setTeamRole}>
                          <input type="hidden" name="teamId" value={team.id} />
                          <input type="hidden" name="userId" value={m.userId} />
                          <input type="hidden" name="role" value={isLead ? 'MEMBER' : 'LEAD'} />
                          {isLead ? (
                            <ConfirmButton
                              size="sm"
                              confirmMessage="Revoke this member's team-lead access? They immediately lose the team views."
                            >
                              Revoke lead
                            </ConfirmButton>
                          ) : (
                            <Button variant="secondary" size="sm" type="submit">
                              Make lead
                            </Button>
                          )}
                        </ActionForm>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
