import { ReportDigest } from '@/components/reports/ReportDigest';
import { PageHeader } from '@/components/team-org/PageHeader';
import { getOrgReport } from '@/lib/reporting-queries';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgCostDuration } from '@/lib/scatter-queries';
import { daysAgo } from '@/lib/time';
import { getOrgActivityHeatmap, getOrgConcurrency, getOrgTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

// The digest is a *trailing* comparison — "this period against the preceding
// period of the same length" — so it only has a meaning for a trailing window.
// It used to also accept from/to/tz/repo, which it silently ignored while the
// charts below honoured them: a request for Jan–Mar 2025 reported 119 sessions
// from the last 60 days beside empty charts, and the download link produced a
// third window again. There is one window now, and every part of the page reads
// it. Arbitrary date ranges live on /org/trends, which can actually honour them.
export default async function OrgReportPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const since = daysAgo(range);
  const until = new Date();
  const options = { timezone: 'UTC', until };

  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getOrgReport(range),
    getOrgTrends(since, options),
    getOrgCostDuration(since, options),
    getOrgConcurrency(since, options),
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

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Organization"
        description="Aggregate activity, ready for a leadership readout."
        range={range}
        title="Organization report"
      />
      <ReportDigest
        apiHref={`/api/org/report?range=${range}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        drilldownHref={`/org/search?from=${report.period.start}&to=${report.period.end}`}
        aggregateScatter
      />
    </div>
  );
}
