import type { NextRequest } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { getOrgReport } from '@/lib/reporting-queries';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { requireOrgViewer } from '@/lib/roles';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging('org.report', async (req: NextRequest) => {
  await requireOrgViewer();
  const report = await getOrgReport(reportDays(req.nextUrl.searchParams.get('range')));
  return reportResponse(report, req.nextUrl.searchParams.get('format'));
});
