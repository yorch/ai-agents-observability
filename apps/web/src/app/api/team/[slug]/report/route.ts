import type { NextRequest } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { getTeamReport } from '@/lib/reporting-queries';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { requireTeamLead } from '@/lib/roles';
import { getTeamCostDuration } from '@/lib/scatter-queries';
import { resolveTeamVisibility } from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';
import { getTeamActivityHeatmap, getTeamConcurrency, getTeamTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging(
  'team.report',
  async (req: NextRequest, context: { params: Promise<{ slug: string }> }) => {
    const { slug } = await context.params;
    const { teamId, teamName } = await requireTeamLead(slug);
    const visibility = await resolveTeamVisibility(teamId);
    // One window for the digest and the analytics alike — see /api/org/report.
    const days = reportDays(req.nextUrl.searchParams.get('range'));
    const since = daysAgo(days);
    const until = new Date();
    const report = await getTeamReport({
      days,
      teamLabel: teamName,
      totalMemberCount: visibility.totalCount,
      visibleIds: visibility.visibleIds,
    });
    const [trends, scatter, concurrency, heatmap] = await Promise.all([
      getTeamTrends(visibility.visibleIds, since, { until }),
      getTeamCostDuration(visibility.visibleIds, since, { until }),
      getTeamConcurrency(visibility.visibleIds, since, { until }),
      getTeamActivityHeatmap(visibility.visibleIds, since, until, 'UTC', undefined),
    ]);
    report.analytics = {
      concurrency: concurrency.map((p) => ({ ...p, day: p.day.toISOString().slice(0, 10) })),
      heatmap,
      scatter,
      trends: trends.map((p) => ({
        costUsd: p.costUsd,
        day: p.day.toISOString().slice(0, 10),
        sessionCount: p.sessionCount,
      })),
    };
    return reportResponse(report, req.nextUrl.searchParams.get('format'));
  },
);
