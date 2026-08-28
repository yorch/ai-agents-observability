import { ReportDigest } from '@/components/reports/ReportDigest';
import { getOrgReport } from '@/lib/reporting-queries';
import { reportDays } from '@/lib/reporting-route';
import { requireOrgViewer } from '@/lib/roles';
import { getOrgTrends } from '@/lib/trend-queries';

export const dynamic = 'force-dynamic';

export default async function OrgReportPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { range } = await searchParams;
  const days = reportDays(range ?? null);
  await requireOrgViewer();
  const [report, trends] = await Promise.all([
    getOrgReport(days),
    getOrgTrends(new Date(Date.now() - days * 86_400_000)),
  ]);
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
      <ReportDigest apiHref={`/api/org/report?range=${days}`} report={report} trends={trends} />
    </div>
  );
}
