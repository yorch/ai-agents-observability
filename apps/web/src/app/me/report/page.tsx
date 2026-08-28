import { redirect } from 'next/navigation';
import { ReportDigest } from '@/components/reports/ReportDigest';
import { currentUser } from '@/lib/auth';
import { getMyReport } from '@/lib/reporting-queries';
import { parseReportRange } from '@/lib/reporting-range';
import { getUserCostDuration } from '@/lib/scatter-queries';
import { getUserActivityHeatmap, getUserConcurrency, getUserTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export default async function MyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string; tz?: string; repo?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  const params = await searchParams;
  const window = parseReportRange(params);
  const days = window.days;
  const since = window.start;
  const options = { repo: params.repo, timezone: window.timezone, until: window.end };
  const [report, trends, scatter, concurrency, heatmap] = await Promise.all([
    getMyReport(user.id, days),
    getUserTrends(user.id, since, options),
    getUserCostDuration(user.id, since, options),
    getUserConcurrency(user.id, since, options),
    getUserActivityHeatmap(user.id, since, window.end, window.timezone, params.repo),
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
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">My report</h1>
        <p className="mt-1 text-sm text-text-2">A shareable summary of your agent activity.</p>
      </div>
      <ReportDigest
        apiHref={`/api/me/report?range=${days}${params.repo ? `&repo=${encodeURIComponent(params.repo)}` : ''}${params.from ? `&from=${params.from}` : ''}${params.to ? `&to=${params.to}` : ''}${params.tz ? `&tz=${encodeURIComponent(params.tz)}` : ''}`}
        report={report}
        trends={trends}
        scatter={scatter}
        concurrency={concurrency}
        heatmap={heatmap}
        drilldownHref={`/me/sessions?from=${window.from}&to=${window.to}${params.repo ? `&repo=${encodeURIComponent(params.repo)}` : ''}`}
      />
    </div>
  );
}
