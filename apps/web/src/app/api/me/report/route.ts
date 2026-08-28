import { type NextRequest, NextResponse } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { currentUser } from '@/lib/auth';
import { getMyReport } from '@/lib/reporting-queries';
import { parseReportRange } from '@/lib/reporting-range';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { getUserCostDuration } from '@/lib/scatter-queries';
import { getUserActivityHeatmap, getUserConcurrency, getUserTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging('me.report', async (req: NextRequest) => {
  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const window = parseReportRange(params);
  const report = await getMyReport(user.id, reportDays(req.nextUrl.searchParams.get('range')));
  const [trends, scatter, concurrency, heatmap] = await Promise.all([
    getUserTrends(user.id, window.start, { repo: params.repo, until: window.end }),
    getUserCostDuration(user.id, window.start, { repo: params.repo, until: window.end }),
    getUserConcurrency(user.id, window.start, { repo: params.repo, until: window.end }),
    getUserActivityHeatmap(user.id, window.start, window.end, window.timezone, params.repo),
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
