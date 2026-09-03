import { type NextRequest, NextResponse } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { currentUser } from '@/lib/auth';
import { getMyReport } from '@/lib/reporting-queries';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { getUserCostDuration } from '@/lib/scatter-queries';
import { daysAgo } from '@/lib/time';
import { getUserActivityHeatmap, getUserConcurrency, getUserTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging('me.report', async (req: NextRequest) => {
  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  // One window for the digest and the analytics alike — see /api/org/report.
  const days = reportDays(req.nextUrl.searchParams.get('range'));
  const since = daysAgo(days);
  const until = new Date();
  const report = await getMyReport(user.id, days);
  const [trends, scatter, concurrency, heatmap] = await Promise.all([
    getUserTrends(user.id, since, { until }),
    getUserCostDuration(user.id, since, { until }),
    getUserConcurrency(user.id, since, { until }),
    getUserActivityHeatmap(user.id, since, until, 'UTC', undefined),
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
});
