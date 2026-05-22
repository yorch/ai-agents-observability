import { redirect } from 'next/navigation';

import { currentUser } from '../../lib/auth';
import { getModelMix, getRecentSessions, getTopTools, getUsageSummary } from '../../lib/me-queries';
import { ModelMixChart } from '../../components/me/ModelMix';
import { RecentSessions } from '../../components/me/RecentSessions';
import { SummaryCards } from '../../components/me/SummaryCards';
import { TopTools } from '../../components/me/TopTools';

export const dynamic = 'force-dynamic';

export default async function MePage() {
  const user = await currentUser();
  if (!user) redirect('/login');

  const now = new Date();
  const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastWeekStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [thisWeek, lastWeek, tools, models, sessions] = await Promise.all([
    getUsageSummary(user.id, thisWeekStart),
    getUsageSummary(user.id, lastWeekStart, thisWeekStart),
    getTopTools(user.id, thisWeekStart),
    getModelMix(user.id, thisWeekStart),
    getRecentSessions(user.id),
  ]);

  const hasData = thisWeek.sessionCount > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8">
      <div>
        <h1 className="text-2xl font-semibold">My Agents</h1>
        <p className="mt-1 text-sm text-white/50">
          Trailing 7 days · {user.displayName ?? user.githubLogin}
        </p>
      </div>
      {!hasData ? (
        <EmptyState />
      ) : (
        <>
          <SummaryCards thisWeek={thisWeek} lastWeek={lastWeek} />
          <div className="grid gap-6 md:grid-cols-2">
            <TopTools tools={tools} />
            <ModelMixChart models={models} />
          </div>
          <RecentSessions sessions={sessions} />
        </>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-white/10 p-8 text-center">
      <p className="text-lg font-medium">No sessions yet</p>
      <p className="mt-2 text-sm text-white/50">
        Install the hook to start tracking your Claude Code sessions.
      </p>
      <a
        href="/install"
        className="mt-4 inline-block rounded-md bg-brand-500 px-4 py-2 text-sm font-medium"
      >
        Install instructions
      </a>
    </div>
  );
}
