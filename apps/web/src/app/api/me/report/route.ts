import { type NextRequest, NextResponse } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { currentUser } from '@/lib/auth';
import { getMyReport } from '@/lib/reporting-queries';
import { reportDays, reportResponse } from '@/lib/reporting-route';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging('me.report', async (req: NextRequest) => {
  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const report = await getMyReport(user.id, reportDays(req.nextUrl.searchParams.get('range')));
  return reportResponse(report, req.nextUrl.searchParams.get('format'));
});
