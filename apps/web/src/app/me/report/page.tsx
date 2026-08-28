import { redirect } from 'next/navigation';
import { ReportDigest } from '@/components/reports/ReportDigest';
import { currentUser } from '@/lib/auth';
import { getMyReport } from '@/lib/reporting-queries';
import { reportDays } from '@/lib/reporting-route';

export const dynamic = 'force-dynamic';

export default async function MyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }
  const { range } = await searchParams;
  const days = reportDays(range ?? null);
  const report = await getMyReport(user.id, days);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">My report</h1>
        <p className="mt-1 text-sm text-text-2">A shareable summary of your agent activity.</p>
      </div>
      <ReportDigest apiHref={`/api/me/report?range=${days}`} report={report} />
    </div>
  );
}
