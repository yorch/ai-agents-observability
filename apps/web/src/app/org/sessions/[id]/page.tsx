import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ModelsTab, ToolsTab } from '@/components/me/SessionTabs';
import { StatusBadge } from '@/components/me/StatusBadge';
import { Timeline } from '@/components/me/Timeline';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { requireOrgAdmin } from '@/lib/roles';
import type { ModelBreakdownRow } from '@/lib/sessions-queries';
import {
  getSession,
  getSessionEvents,
  getSessionModelBreakdown,
  getSessionOrgContext,
} from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };
type SearchParams = { tab?: string };

export default async function OrgSessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  // Org-admin only — viewer_aggregate must never reach an individual session.
  const { user } = await requireOrgAdmin();

  const ctx = await getSessionOrgContext(id);
  if (!ctx) {
    notFound();
  }

  // §8.3: every org-admin view of another user's session is audited.
  void writeAuditLog({
    action: AuditAction.view_session,
    actorUserId: user.id,
    targetSessionId: id,
    targetUserId: ctx.ownerUserId,
  });

  const { tab = 'timeline' } = await searchParams;

  const [session, modelBreakdown, sessionEvents] = await Promise.all([
    getSession(ctx.ownerUserId, id),
    tab === 'models'
      ? getSessionModelBreakdown(ctx.ownerUserId, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(ctx.ownerUserId, id) : Promise.resolve([]),
  ]);
  if (!session) {
    notFound();
  }

  const owner = ctx.displayName ?? (ctx.ownerLogin ? `@${ctx.ownerLogin}` : 'Unknown user');
  const tabs = [
    { href: '?tab=timeline', id: 'timeline', label: 'Timeline' },
    { href: '?tab=tools', id: 'tools', label: 'Tools' },
    { href: '?tab=models', id: 'models', label: 'Models' },
  ];

  return (
    <div className="space-y-6">
      <Link href="/org/search" className="text-sm text-white/50 hover:text-white">
        ← Search
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{session.repoName ?? 'Unknown repo'}</h1>
            <StatusBadge status={session.status} />
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-white/50">
            <span>{owner}</span>
            {session.branch && <span>branch: {session.branch}</span>}
            {session.commitSha && <span>commit: {session.commitSha.slice(0, 7)}</span>}
            <span>started: {session.startedAt.toLocaleString()}</span>
            {session.endedAt && <span>ended: {session.endedAt.toLocaleString()}</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-white/70">${session.costUsd.toFixed(4)}</span>
          {session.transcriptS3Key && (
            <Link
              href={`/org/sessions/${id}/transcript`}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 transition-colors"
            >
              {ctx.shareTranscriptsWithOrg ? 'View transcript' : 'Request transcript access'}
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

      {tab === 'timeline' && <Timeline events={sessionEvents} session={session} />}
      {tab === 'tools' && <ToolsTab session={session} />}
      {tab === 'models' && <ModelsTab costUsd={session.costUsd} rows={modelBreakdown} />}
    </div>
  );
}
