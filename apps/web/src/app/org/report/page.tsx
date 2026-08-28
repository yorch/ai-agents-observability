import { ReportDigest } from '@/components/reports/ReportDigest';
import { getOrgReport } from '@/lib/reporting-queries';
import { parseReportRange } from '@/lib/reporting-range';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgCostDuration } from '@/lib/scatter-queries';
import { getOrgActivityHeatmap, getOrgConcurrency, getOrgTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export default async function OrgReportPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  const params = await searchParams;
  const window = parseReportRange(params);
  const days = window.days;
  await requireOrgViewer();
  const since = window.start;
  const options = { repo: params.repo, timezone: window.timezone, until: window.end };
  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getOrgReport(days),
    getOrgTrends(since, options),
    getOrgCostDuration(since, options),
    getOrgConcurrency(since, options),
    getOrgActivityHeatmap(since, window.end, window.timezone, params.repo),
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
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-wider text-text-3">Organization</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          Organization report
        </h1>
        <p className="mt-1 text-sm text-text-2">
          Aggregate activity, ready for a leadership readout.
        </p>
      </div>
      <ReportDigest
        apiHref={`/api/org/report?range=${days}${params.repo ? `&repo=${encodeURIComponent(params.repo)}` : ''}${params.from ? `&from=${params.from}` : ''}${params.to ? `&to=${params.to}` : ''}${params.tz ? `&tz=${encodeURIComponent(params.tz)}` : ''}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        drilldownHref={`/org/sessions?from=${window.from}&to=${window.to}${params.repo ? `&repo=${encodeURIComponent(params.repo)}` : ''}`}
        aggregateScatter
      />
    </div>
  );
}
