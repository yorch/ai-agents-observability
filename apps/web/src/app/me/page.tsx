import { agentDisplayName, DEFAULT_AGENT_TYPE } from '@ai-agents-observability/schemas';
import { redirect } from 'next/navigation';
import { FrictionTrendChart } from '@/components/me/FrictionTrendChart';
import { ModelMixChart } from '@/components/me/ModelMix';
import { RecentSessions } from '@/components/me/RecentSessions';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { SummaryCards } from '@/components/me/SummaryCards';
import { TopTools } from '@/components/me/TopTools';
import { currentUser } from '@/lib/auth';
import { getUserEffectiveness } from '@/lib/effectiveness-queries';
import { getModelMix, getRecentSessions, getTopTools, getUsageSummary } from '@/lib/me-queries';

export const dynamic = 'force-dynamic';

const DAYS_OPTS = [7, 30, 90] as const;
type Days = (typeof DAYS_OPTS)[number];

function parseDays(raw: string | undefined): Days {
  const n = Number(raw);
  return (DAYS_OPTS as readonly number[]).includes(n) ? (n as Days) : 7;
}

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const params = await searchParams;
  const days = parseDays(params.days);

  const now = new Date();
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevPeriodStart = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [thisPeriod, lastPeriod, tools, models, sessions, effectiveness] = await Promise.all([
    getUsageSummary(user.id, periodStart),
    getUsageSummary(user.id, prevPeriodStart, periodStart),
    getTopTools(user.id, periodStart),
    getModelMix(user.id, periodStart),
    getRecentSessions(user.id),
    getUserEffectiveness(user.id, { since: thirtyDaysAgo }),
  ]);

  const hasData = thisPeriod.sessionCount > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">My Agents</h1>
          <p className="mt-1 text-sm text-white/50">
            {user.displayName ?? user.githubLogin}
          </p>
        </div>
        <DaysSelector current={days} />
      </div>
      {!hasData ? (
        <EmptyState />
      ) : (
        <>
          <SummaryCards thisWeek={thisPeriod} lastWeek={lastPeriod} />
          <div className="grid gap-6 md:grid-cols-2">
            <TopTools tools={tools} />
            <ModelMixChart models={models} />
          </div>
          <div>
            <p className="mb-3 text-xs text-white/40">Effectiveness · trailing 30 days</p>
            <div className="grid gap-6 md:grid-cols-2">
              <FrictionTrendChart
                points={effectiveness.trend}
                scoredSessionCount={effectiveness.scoredSessionCount}
              />
              <ShapeDistributionChart histogram={effectiveness.shapeHistogram} />
            </div>
          </div>
          <RecentSessions sessions={sessions} />
        </>
      )}
    </div>
  );
}

function DaysSelector({ current }: { current: Days }) {
  return (
    <div className="flex gap-1 rounded-lg border border-white/10 bg-white/5 p-1">
      {DAYS_OPTS.map((d) => (
        <a
          key={d}
          href={`/me?days=${d}`}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            current === d
              ? 'bg-brand-500 text-white'
              : 'text-white/50 hover:text-white hover:bg-white/10'
          }`}
        >
          {d}d
        </a>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-white/10 p-8 text-center">
      <p className="text-lg font-medium">No sessions yet</p>
      <p className="mt-2 text-sm text-white/50">
        Install the hook to start tracking your {agentDisplayName(DEFAULT_AGENT_TYPE)} sessions.
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
