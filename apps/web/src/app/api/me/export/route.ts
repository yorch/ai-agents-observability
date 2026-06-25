import { type NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { listSessions } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(',')),
  ];
  return lines.join('\n');
}

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const sp = req.nextUrl.searchParams;

  const parseDate = (s: string | null): Date | undefined => {
    if (!s) return undefined;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  const repo = sp.get('repo') ?? undefined;
  const status = sp.get('status') ?? undefined;
  const shape = sp.get('shape') ?? undefined;
  const agent = sp.get('agent') ?? undefined;
  const dateFrom = parseDate(sp.get('from'));
  const dateTo = parseDate(sp.get('to'));
  const bandRaw = sp.get('band');
  const frictionBand =
    bandRaw === 'low' || bandRaw === 'medium' || bandRaw === 'high' ? bandRaw : undefined;

  // Export up to 10 000 rows (no pagination for exports)
  const { sessions } = await listSessions(user.id, {
    ...(repo ? { repo } : {}),
    ...(status ? { status } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(shape ? { shapeLabels: [shape] } : {}),
    ...(agent ? { agentTypes: [agent] } : {}),
    ...(frictionBand ? { frictionBand } : {}),
    page: 1,
    pageSize: 10_000,
  });

  const rows = sessions.map((s) => ({
    session_id: s.sessionId,
    started_at: s.startedAt.toISOString(),
    ended_at: s.endedAt?.toISOString() ?? '',
    status: s.status,
    repo: s.repoName ?? '',
    git_branch: s.gitBranch ?? '',
    agent_type: s.agentType,
    primary_model: s.primaryModel ?? '',
    total_cost_usd: s.totalCostUsd,
    total_input_tokens: s.totalInputTokens,
    total_output_tokens: s.totalOutputTokens,
    tool_call_count: s.toolCallCount,
    tool_error_count: s.toolErrorCount,
    permission_deny_count: s.permissionDenyCount,
    duration_seconds: s.durationSeconds ?? '',
    friction_score: s.frictionScore ?? '',
    shape_label: s.shapeLabel ?? '',
  }));

  const csv = toCSV(rows);
  return new NextResponse(csv, {
    headers: {
      'Content-Disposition': 'attachment; filename="sessions.csv"',
      'Content-Type': 'text/csv; charset=utf-8',
    },
  });
}
