import Link from 'next/link';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Card, Cell, EmptyState, Row, Table } from '@/components/ui';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { fmtUsd } from '@/lib/fmt';
import { requireTeamLead } from '@/lib/roles';
import { getTeamRoster } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  lead: 'Lead',
  maintainer: 'Maintainer',
  member: 'Member',
};

export default async function TeamRosterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const { teamId, teamName, user } = await requireTeamLead(slug);

  const since = daysAgo(range);

  // Audit write is fire-and-forget per P3-005: never throws, errors logged to stderr.
  void writeAuditLog({
    action: AuditAction.EXPORT_TEAM,
    actorUserId: user.id,
    targetTeamId: teamId,
  });
  const members = await getTeamRoster(teamId, since);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb={teamName}
        description={`${members.length} ${members.length === 1 ? 'member' : 'members'} · trailing ${range} days`}
        range={range}
        title="Roster"
      />

      {members.length === 0 ? (
        <EmptyState>No members in this team yet.</EmptyState>
      ) : (
        <Card>
          <Table
            columns={[
              { label: 'Member' },
              { label: 'Role' },
              { align: 'right', label: `Sessions (${range}d)` },
              { align: 'right', label: `Cost (${range}d)` },
            ]}
          >
            {members.map((m) => {
              // githubLogin is nullable (password-auth users); the member route is
              // keyed on it, so no login means no link and no "@" line.
              const name =
                m.displayName ?? (m.githubLogin ? `@${m.githubLogin}` : 'Unknown member');
              return (
                <Row key={m.userId}>
                  <Cell>
                    <div className="flex items-center gap-3">
                      <div>
                        {m.canViewStats && m.githubLogin ? (
                          <Link
                            href={`/team/${slug}/member/${m.githubLogin}`}
                            className="font-medium text-text hover:text-text-2"
                          >
                            {name}
                          </Link>
                        ) : (
                          <p className="font-medium text-text">{name}</p>
                        )}
                        {m.displayName && m.githubLogin && (
                          <p className="text-xs text-text-3">@{m.githubLogin}</p>
                        )}
                      </div>
                    </div>
                  </Cell>
                  <Cell>
                    <span className="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-text-2">
                      {ROLE_LABEL[m.role] ?? m.role}
                    </span>
                  </Cell>
                  {m.canViewStats ? (
                    <>
                      <Cell num className="text-text-2">
                        {m.sessionCount ?? 0}
                      </Cell>
                      <Cell num className="text-text-2">
                        {fmtUsd(m.totalCostUsd ?? 0)}
                      </Cell>
                    </>
                  ) : (
                    <Cell colSpan={2} num className="text-xs text-text-3 italic">
                      Privacy opted out
                    </Cell>
                  )}
                </Row>
              );
            })}
          </Table>
        </Card>
      )}

      <p className="text-xs text-text-3">
        Members who have set their privacy to not share team metadata are shown without stats.{' '}
        <Link href="/me/settings/privacy" className="underline hover:text-text-2">
          Manage your own privacy settings.
        </Link>
      </p>
    </div>
  );
}
