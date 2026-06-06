import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ModelsTab, ToolsTab } from '@/components/me/SessionTabs';
import { Timeline } from '@/components/me/Timeline';
import { currentUser } from '@/lib/auth';
import type { ModelBreakdownRow } from '@/lib/sessions-queries';
import { getSession, getSessionModelBreakdown } from '@/lib/sessions-queries';

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

type PageParams = { id: string };
type SearchParams = { tab?: string };

export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const { id } = await params;
  const { tab = 'timeline' } = await searchParams;

  // The breakdown only needs userId+sessionId (not the session row), so when the
  // models tab is active run both queries concurrently instead of serially.
  const [session, modelBreakdown] = await Promise.all([
    getSession(user.id, id),
    tab === 'models'
      ? getSessionModelBreakdown(user.id, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
  ]);
  if (!session) {
    notFound();
  }

  const tabs = [
    { href: `?tab=timeline`, id: 'timeline', label: 'Timeline' },
    { href: `?tab=tools`, id: 'tools', label: 'Tools' },
    { href: `?tab=models`, id: 'models', label: 'Models' },
  ];

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link href="/me/sessions" className="text-sm text-white/50 hover:text-white">
        ← Sessions
      </Link>

      {/* Header */}
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
          {session.transcriptS3Key && (
            <Link
              href={`/me/sessions/${id}/transcript`}
              className="rounded-md border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 transition-colors"
            >
              View transcript
            </Link>
          )}
        </div>
      </div>

      {/* Tabs */}
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

      {/* Tab content */}
      {tab === 'timeline' && <Timeline session={session} />}
      {tab === 'tools' && <ToolsTab session={session} />}
      {tab === 'models' && <ModelsTab costUsd={session.costUsd} rows={modelBreakdown} />}
    </div>
  );
}
