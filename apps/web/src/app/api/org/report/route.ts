import type { NextRequest } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { getOrgReport } from '@/lib/reporting-queries';
import { parseReportRange } from '@/lib/reporting-range';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgCostDuration } from '@/lib/scatter-queries';
import { getOrgActivityHeatmap, getOrgConcurrency, getOrgTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging('org.report', async (req: NextRequest) => {
  await requireOrgViewer();
  const params = Object.fromEntries(req.nextUrl.searchParams.entries());
  const window = parseReportRange(params);
  const report = await getOrgReport(reportDays(req.nextUrl.searchParams.get('range')));
  const [trends, scatter, concurrency, heatmap] = await Promise.all([
    getOrgTrends(window.start, { repo: params.repo, until: window.end }),
    getOrgCostDuration(window.start, { repo: params.repo, until: window.end }),
    getOrgConcurrency(window.start, { repo: params.repo, until: window.end }),
    getOrgActivityHeatmap(window.start, window.end, window.timezone, params.repo),
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
