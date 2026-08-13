import { agentDisplayName, DEFAULT_AGENT_TYPE } from '@ai-agents-observability/schemas';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { DaysSelector, parseDays } from '@/components/me/DaysSelector';
import { FrictionTrendChart } from '@/components/me/FrictionTrendChart';
import { ModelMixChart } from '@/components/me/ModelMix';
import { OversightPanel } from '@/components/me/OversightPanel';
import { RecentSessions } from '@/components/me/RecentSessions';
import { ShapeDistributionChart } from '@/components/me/ShapeDistributionChart';
import { SummaryCards } from '@/components/me/SummaryCards';
import { TopTools } from '@/components/me/TopTools';
import { ButtonLink, EmptyState, SkeletonCard } from '@/components/ui';
import { currentUser } from '@/lib/auth';
import { getUserEffectiveness } from '@/lib/effectiveness-queries';
import { getModelMix, getRecentSessions, getTopTools, getUsageSummary } from '@/lib/me-queries';
import { getUserOversight } from '@/lib/oversight-queries';

export const dynamic = 'force-dynamic';

/* The page gates only on the summary pair (which also decides the empty
   state); every other section streams in behind its own Suspense boundary, so
   the header and stat row paint without waiting for the slowest query. */

async function OversightSection({ periodStart, userId }: { periodStart: Date; userId: string }) {
  const oversight = await getUserOversight(userId, periodStart);
  return <OversightPanel data={oversight} />;
}

async function ToolsAndModels({ periodStart, userId }: { periodStart: Date; userId: string }) {
  const [tools, models] = await Promise.all([
    getTopTools(userId, periodStart),
    getModelMix(userId, periodStart),
  ]);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <TopTools tools={tools} />
      <ModelMixChart models={models} />
    </div>
  );
}

async function EffectivenessSection({ since, userId }: { since: Date; userId: string }) {
  const effectiveness = await getUserEffectiveness(userId, { since });
  return (
    <div>
      <p className="mb-3 text-xs text-text-3 uppercase tracking-widest">
        Effectiveness · trailing 30 days
      </p>
      <div className="grid gap-6 md:grid-cols-2">
        <FrictionTrendChart
          points={effectiveness.trend}
          scoredSessionCount={effectiveness.scoredSessionCount}
        />
        <ShapeDistributionChart histogram={effectiveness.shapeHistogram} />
      </div>
    </div>
  );
}

async function RecentSessionsSection({ userId }: { userId: string }) {
  const sessions = await getRecentSessions(userId);
  return <RecentSessions sessions={sessions} />;
}

function SectionSkeleton({ split = false }: { split?: boolean }) {
  return split ? (
    <div className="grid animate-pulse gap-6 motion-reduce:animate-none md:grid-cols-2">
      <SkeletonCard className="h-56" />
      <SkeletonCard className="h-56" />
    </div>
  ) : (
    <SkeletonCard className="h-44 animate-pulse motion-reduce:animate-none" />
  );
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

  const [thisPeriod, lastPeriod] = await Promise.all([
    getUsageSummary(user.id, periodStart),
    getUsageSummary(user.id, prevPeriodStart, periodStart),
  ]);

  const hasData = thisPeriod.sessionCount > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            My Agents
          </h1>
          <p className="mt-1 text-sm text-text-2">{user.displayName ?? user.githubLogin}</p>
        </div>
        <DaysSelector basePath="/me" current={days} />
      </div>
      {!hasData ? (
        <EmptyState
          title="No sessions yet"
          action={<ButtonLink href="/install">Install instructions</ButtonLink>}
        >
          Install the hook to start tracking your {agentDisplayName(DEFAULT_AGENT_TYPE)} sessions.
        </EmptyState>
      ) : (
        <>
          <SummaryCards thisWeek={thisPeriod} lastWeek={lastPeriod} />
          <Suspense fallback={<SectionSkeleton />}>
            <OversightSection userId={user.id} periodStart={periodStart} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton split />}>
            <ToolsAndModels userId={user.id} periodStart={periodStart} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton split />}>
            <EffectivenessSection userId={user.id} since={thirtyDaysAgo} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <RecentSessionsSection userId={user.id} />
          </Suspense>
        </>
      )}
    </div>
  );
}
