import { redirect } from 'next/navigation';
import { ReportDigest } from '@/components/reports/ReportDigest';
import { PageHeader } from '@/components/team-org/PageHeader';
import { currentUser } from '@/lib/auth';
import { getMyReport } from '@/lib/reporting-queries';
import { getUserCostDuration } from '@/lib/scatter-queries';
import { daysAgo } from '@/lib/time';
import { getUserActivityHeatmap, getUserConcurrency, getUserTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

// One trailing window, read by the digest, the charts and the download alike.
// See the note on /org/report for why an arbitrary from/to has no meaning for a
// period-over-period digest, and why those belong on the trends pages instead.
export default async function MyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const since = daysAgo(range);
  const until = new Date();
  const options = { timezone: 'UTC', until };

  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getMyReport(user.id, range),
    getUserTrends(user.id, since, options),
    getUserCostDuration(user.id, since, options),
    getUserConcurrency(user.id, since, options),
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

  return (
    <div className="space-y-6">
      <PageHeader
        description="A shareable summary of your agent activity."
        range={range}
        title="My report"
      />
      <ReportDigest
        apiHref={`/api/me/report?range=${range}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        drilldownHref={`/me/sessions?from=${report.period.start}&to=${report.period.end}`}
      />
    </div>
  );
}
