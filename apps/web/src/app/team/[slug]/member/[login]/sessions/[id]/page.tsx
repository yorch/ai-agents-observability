import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Timeline } from '../../../../../../../components/me/Timeline';
import { AuditAction, writeAuditLog } from '../../../../../../../lib/audit';
import { requireTeamLead } from '../../../../../../../lib/roles';
import type { ModelBreakdownRow } from '../../../../../../../lib/sessions-queries';
import { getSession, getSessionModelBreakdown } from '../../../../../../../lib/sessions-queries';
import { getMemberForTeam } from '../../../../../../../lib/team-queries';

export const dynamic = 'force-dynamic';

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    abandoned: 'bg-yellow-500/20 text-yellow-400',
    active: 'bg-green-500/20 text-green-400',
    completed: 'bg-blue-500/20 text-blue-400',
    crashed: 'bg-red-500/20 text-red-400',
    timed_out: 'bg-orange-500/20 text-orange-400',
  };
  const color = colors[status] ?? 'bg-white/10 text-white/50';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}

function ToolsTab({ session }: { session: Awaited<ReturnType<typeof getSession>> & object }) {
  const modelCounts = [
    { label: 'Opus turns', value: session.opusTurns },
    { label: 'Sonnet turns', value: session.sonnetTurns },
    { label: 'Haiku turns', value: session.haikuTurns },
    { label: 'Tool calls', value: session.toolCallCount },
    { label: 'Tool errors', value: session.toolErrorCount },
  ];
  const max = Math.max(...modelCounts.map((m) => m.value), 1);

  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-medium text-white/70">Tool &amp; Model Activity</h3>
      {modelCounts.map((m) => (
        <div key={m.label}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-white/70">{m.label}</span>
            <span className="text-white/50">{m.value}</span>
          </div>
          <div className="h-2 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${(m.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelsTab({ costUsd, rows }: { costUsd: number; rows: ModelBreakdownRow[] }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <h3 className="text-sm font-medium text-white/70 mb-4">Model Breakdown</h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-white/40 text-xs border-b border-white/10">
            <th className="text-left pb-2">Model</th>
            <th className="text-right pb-2">Calls</th>
            <th className="text-right pb-2">Input tokens</th>
            <th className="text-right pb-2">Output tokens</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="pt-4 text-center text-white/40">
                No model data
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.model} className="border-b border-white/5">
                <td className="py-2 text-white/70">{r.model}</td>
                <td className="py-2 text-right text-white/60">{r.calls}</td>
                <td className="py-2 text-right text-white/60">
                  {r.inputTokens > 0n ? r.inputTokens.toString() : '—'}
                </td>
                <td className="py-2 text-right text-white/60">
                  {r.outputTokens > 0n ? r.outputTokens.toString() : '—'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="mt-4 pt-4 border-t border-white/10 text-xs text-white/40">
        Total cost: <span className="text-white/70">${costUsd.toFixed(4)}</span>
      </div>
    </div>
  );
}

type PageParams = { id: string; login: string; slug: string };
type SearchParams = { tab?: string };

export default async function TeamMemberSessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const { id, login, slug } = await params;
  const { teamId, user } = await requireTeamLead(slug);

  const member = await getMemberForTeam(teamId, login);
  if (!member || !member.canViewStats) {
    notFound();
  }

  const { tab = 'timeline' } = await searchParams;

  const [session, modelBreakdown] = await Promise.all([
    getSession(member.userId, id),
    tab === 'models'
      ? getSessionModelBreakdown(member.userId, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
  ]);
  if (!session) {
    notFound();
  }

  // P3-005: fire-and-forget audit — never throws, errors logged to stderr.
  void writeAuditLog({
    action: AuditAction.view_session,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: member.userId,
  });

  const displayName = member.displayName ?? `@${member.githubLogin}`;
  const tabs = [
    { href: '?tab=timeline', id: 'timeline', label: 'Timeline' },
    { href: '?tab=tools', id: 'tools', label: 'Tools' },
    { href: '?tab=models', id: 'models', label: 'Models' },
  ];

  return (
    <div className="space-y-6">
      <Link
        href={`/team/${slug}/member/${login}`}
        className="text-sm text-white/50 hover:text-white"
      >
        ← {displayName}
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{session.repoName ?? 'Unknown repo'}</h1>
            <StatusBadge status={session.status} />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-white/50">
            {session.branch && <span>branch: {session.branch}</span>}
            {session.commitSha && <span>commit: {session.commitSha.slice(0, 7)}</span>}
            <span>started: {session.startedAt.toLocaleString()}</span>
            {session.endedAt && <span>ended: {session.endedAt.toLocaleString()}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-white/70">${session.costUsd.toFixed(4)}</span>
          {session.transcriptS3Key && member.canViewTranscripts && (
            <Link
              href={`/team/${slug}/member/${login}/sessions/${id}/transcript`}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 transition-colors"
            >
              View transcript
            </Link>
          )}
        </div>
      </div>

      <div className="border-b border-white/10">
        <nav className="flex gap-4 text-sm">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={t.href}
              className={`pb-3 border-b-2 transition-colors ${
                tab === t.id
                  ? 'border-brand-500 text-white'
                  : 'border-transparent text-white/50 hover:text-white'
              }`}
            >
              {t.label}
            </a>
          ))}
        </nav>
      </div>

      {tab === 'timeline' && <Timeline session={session} />}
      {tab === 'tools' && <ToolsTab session={session} />}
      {tab === 'models' && <ModelsTab costUsd={session.costUsd} rows={modelBreakdown} />}
    </div>
  );
}
