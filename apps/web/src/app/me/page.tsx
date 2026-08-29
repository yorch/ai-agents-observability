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
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { currentUser } from '@/lib/auth';
import { getUserEffectiveness } from '@/lib/effectiveness-queries';
import { getModelMix, getRecentSessions, getTopTools, getUsageSummary } from '@/lib/me-queries';
import { getUserOversight } from '@/lib/oversight-queries';

export const dynamic = 'force-dynamic';

/* The page gates only on the summary pair (which also decides the empty
   state); every other section streams in behind its own Suspense boundary, so
   the header and stat row paint without waiting for the slowest query. */

async function OversightSection({ oversight }: { oversight: ReturnType<typeof getUserOversight> }) {
  return <OversightPanel data={await oversight} />;
}

async function ToolsAndModels({
  models,
  tools,
}: {
  models: ReturnType<typeof getModelMix>;
  tools: ReturnType<typeof getTopTools>;
}) {
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <TopTools tools={await tools} />
      <ModelMixChart models={await models} />
    </div>
  );
}

async function EffectivenessSection({
  effectiveness: effectivenessPromise,
}: {
  effectiveness: ReturnType<typeof getUserEffectiveness>;
}) {
  const { dict } = await getTranslations();
  const effectiveness = await effectivenessPromise;
  return (
    <div>
      <p className="mb-3 text-xs text-text-3 uppercase tracking-widest">
        {dict.me.effectivenessTrailing}
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

async function RecentSessionsSection({
  sessions,
}: {
  sessions: ReturnType<typeof getRecentSessions>;
}) {
  return <RecentSessions sessions={await sessions} />;
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

  const { dict } = await getTranslations();
  const params = await searchParams;
  const days = parseDays(params.days);

  const now = new Date();
  const periodStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const prevPeriodStart = new Date(now.getTime() - 2 * days * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Kick every section query off before the first await so the Suspense
  // refactor keeps the old Promise.all parallelism — sections stream in as
  // they resolve rather than starting after the summary pair lands.
  const oversightP = getUserOversight(user.id, periodStart);
  const toolsP = getTopTools(user.id, periodStart);
  const modelsP = getModelMix(user.id, periodStart);
  const effectivenessP = getUserEffectiveness(user.id, { since: thirtyDaysAgo });
  const sessionsP = getRecentSessions(user.id);
  // A rejected section promise is surfaced by its own Suspense boundary; this
  // keeps an early summary throw from also logging an unhandled rejection.
  for (const p of [oversightP, toolsP, modelsP, effectivenessP, sessionsP]) {
    (p as Promise<unknown>).catch(() => {});
  }

  const [thisPeriod, lastPeriod] = await Promise.all([
    getUsageSummary(user.id, periodStart),
    getUsageSummary(user.id, prevPeriodStart, periodStart),
  ]);

  const hasData = thisPeriod.sessionCount > 0;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            {dict.me.pageTitle}
          </h1>
          <p className="mt-1 text-sm text-text-2">{user.displayName ?? user.githubLogin}</p>
        </div>
        <DaysSelector basePath="/me" current={days} />
      </div>
      {!hasData ? (
        <EmptyState
          title={dict.me.noSessionsTitle}
          action={<ButtonLink href="/install">{dict.me.noSessionsAction}</ButtonLink>}
        >
          {format(dict.me.noSessionsBody, { agent: dict.agents.CLAUDE_CODE })}
        </EmptyState>
      ) : (
        <>
          <SummaryCards thisWeek={thisPeriod} lastWeek={lastPeriod} />
          <Suspense fallback={<SectionSkeleton />}>
            <OversightSection oversight={oversightP} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton split />}>
            <ToolsAndModels tools={toolsP} models={modelsP} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton split />}>
            <EffectivenessSection effectiveness={effectivenessP} />
          </Suspense>
          <Suspense fallback={<SectionSkeleton />}>
            <RecentSessionsSection sessions={sessionsP} />
          </Suspense>
        </>
      )}
    </div>
  );
}
