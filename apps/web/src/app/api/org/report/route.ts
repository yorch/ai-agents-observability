import type { NextRequest } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { getOrgReport } from '@/lib/reporting-queries';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgCostDuration } from '@/lib/scatter-queries';
import { daysAgo } from '@/lib/time';
import { getOrgActivityHeatmap, getOrgConcurrency, getOrgTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging('org.report', async (req: NextRequest) => {
  await requireOrgViewer();
  // One window for the digest and the analytics alike. This route used to build
  // the digest from `range` while the charts came from a parseReportRange() over
  // from/to/repo, so a download could disagree with itself.
  const days = reportDays(req.nextUrl.searchParams.get('range'));
  const since = daysAgo(days);
  const until = new Date();
  const report = await getOrgReport(days);
  const [trends, scatter, concurrency, heatmap] = await Promise.all([
    getOrgTrends(since, { until }),
    getOrgCostDuration(since, { until }),
    getOrgConcurrency(since, { until }),
    getOrgActivityHeatmap(since, until, 'UTC', undefined),
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
