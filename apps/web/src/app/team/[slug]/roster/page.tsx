import Link from 'next/link';

import { AuditAction, writeAuditLog } from '../../../../lib/audit';
import { requireTeamLead } from '../../../../lib/roles';
import { getTeamRoster } from '../../../../lib/team-queries';
import { daysAgo } from '../../../../lib/time';
import { TeamSubNav } from '../layout';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  lead: 'Lead',
  maintainer: 'Maintainer',
  member: 'Member',
};

export default async function TeamRosterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { teamId, teamName, user } = await requireTeamLead(slug);

  const since = daysAgo(30);

  // Audit write is fire-and-forget per P3-005: never throws, errors logged to stderr.
  void writeAuditLog({
    action: AuditAction.export_team,
    actorUserId: user.id,
    targetTeamId: teamId,
  });
  const members = await getTeamRoster(teamId, since);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Team</p>
        <h1 className="text-2xl font-semibold">{teamName}</h1>
        <p className="mt-1 text-sm text-white/50">
          {members.length} {members.length === 1 ? 'member' : 'members'} · trailing 30 days
        </p>
      </div>

      <TeamSubNav slug={slug} active="roster" />

      {members.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-white/50">No members in this team yet.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs text-white/40">
                <th className="px-4 py-3 text-left font-medium">Member</th>
                <th className="px-4 py-3 text-left font-medium">Role</th>
                <th className="px-4 py-3 text-right font-medium">Sessions (30d)</th>
                <th className="px-4 py-3 text-right font-medium">Cost (30d)</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.userId}
                  className="border-b border-white/5 hover:bg-white/5 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div>
                        {m.canViewStats ? (
                          <Link
                            href={`/team/${slug}/member/${m.githubLogin}`}
                            className="font-medium text-white hover:text-white/70"
                          >
                            {m.displayName ?? m.githubLogin}
                          </Link>
                        ) : (
                          <p className="font-medium text-white">{m.displayName ?? m.githubLogin}</p>
                        )}
                        {m.displayName && <p className="text-xs text-white/40">@{m.githubLogin}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-white/60">
                      {ROLE_LABEL[m.role] ?? m.role}
                    </span>
                  </td>
                  {m.canViewStats ? (
                    <>
                      <td className="px-4 py-3 text-right text-white/70">{m.sessionCount ?? 0}</td>
                      <td className="px-4 py-3 text-right text-white/70">
                        ${(m.totalCostUsd ?? 0).toFixed(2)}
                      </td>
                    </>
                  ) : (
                    <td colSpan={2} className="px-4 py-3 text-right text-xs text-white/30 italic">
                      Privacy opted out
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-white/30">
        Members who have set their privacy to not share team metadata are shown without stats.{' '}
        <Link href="/me/privacy" className="underline hover:text-white/60">
          Manage your own privacy settings.
        </Link>
      </p>
    </div>
  );
}
