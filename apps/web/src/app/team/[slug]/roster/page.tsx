import Link from 'next/link';
import { DateRangePicker } from '@/components/team-org/DateRangePicker';
import { Cell, EmptyState, Row, Table } from '@/components/ui';
import { AuditAction, writeAuditLog } from '@/lib/audit';
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
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Team</p>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            {teamName}
          </h1>
          <p className="mt-1 text-sm text-text-2">
            {members.length} {members.length === 1 ? 'member' : 'members'} · trailing {range} days
          </p>
        </div>
        <DateRangePicker range={range} />
      </div>

      {members.length === 0 ? (
        <EmptyState>No members in this team yet.</EmptyState>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table
            columns={[
              { label: 'Member' },
              { label: 'Role' },
              { align: 'right', label: `Sessions (${range}d)` },
              { align: 'right', label: `Cost (${range}d)` },
            ]}
          >
            {members.map((m) => (
              <Row key={m.userId}>
                <Cell>
                  <div className="flex items-center gap-3">
                    <div>
                      {m.canViewStats ? (
                        <Link
                          href={`/team/${slug}/member/${m.githubLogin}`}
                          className="font-medium text-text hover:text-text-2"
                        >
                          {m.displayName ?? m.githubLogin}
                        </Link>
                      ) : (
                        <p className="font-medium text-text">{m.displayName ?? m.githubLogin}</p>
                      )}
                      {m.displayName && <p className="text-xs text-text-3">@{m.githubLogin}</p>}
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
                      ${(m.totalCostUsd ?? 0).toFixed(2)}
                    </Cell>
                  </>
                ) : (
                  <Cell colSpan={2} num className="text-xs text-text-3 italic">
                    Privacy opted out
                  </Cell>
                )}
              </Row>
            ))}
          </Table>
        </div>
      )}

      <p className="text-xs text-text-3">
        Members who have set their privacy to not share team metadata are shown without stats.{' '}
        <Link href="/me/privacy" className="underline hover:text-text-2">
          Manage your own privacy settings.
        </Link>
      </p>
    </div>
  );
}
