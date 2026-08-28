import type { NextRequest } from 'next/server';
import { withRouteLogging } from '@/lib/api-logging';
import { getTeamReport } from '@/lib/reporting-queries';
import { reportDays, reportResponse } from '@/lib/reporting-route';
import { requireTeamLead } from '@/lib/roles';
import { resolveTeamVisibility } from '@/lib/team-queries';

export const dynamic = 'force-dynamic';

export const GET = withRouteLogging(
  'team.report',
  async (req: NextRequest, context: { params: Promise<{ slug: string }> }) => {
    const { slug } = await context.params;
    const { teamId, teamName } = await requireTeamLead(slug);
    const visibility = await resolveTeamVisibility(teamId);
    const report = await getTeamReport({
      days: reportDays(req.nextUrl.searchParams.get('range')),
      teamLabel: teamName,
      totalMemberCount: visibility.totalCount,
      visibleIds: visibility.visibleIds,
    });
    return reportResponse(report, req.nextUrl.searchParams.get('format'));
  },
);
