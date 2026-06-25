import { type NextRequest, NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth';
import { listSessions } from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return '';
  }
  const first = rows[0];
  const headers = Object.keys(first as object);
  const escapeCell = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(',')),
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
    if (!s) {
      return undefined;
    }
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

  // listSessions returns up to PAGE_SIZE (50) per page — iterate all pages for export
  const allSessions = [];
  let page = 1;
  while (true) {
    const { sessions, total } = await listSessions(user.id, {
      ...(repo ? { repo } : {}),
      ...(status ? { status } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(shape ? { shapeLabels: [shape] } : {}),
      ...(agent ? { agentTypes: [agent] } : {}),
      ...(frictionBand ? { frictionBand } : {}),
      page,
    });
    allSessions.push(...sessions);
    if (allSessions.length >= total || sessions.length === 0) {
      break;
    }
    page++;
  }

  const rows = allSessions.map((s) => ({
    cost_usd: s.costUsd,
    duration_seconds: s.durationSeconds ?? '',
    ended_at: s.endedAt?.toISOString() ?? '',
    event_count: s.eventCount,
    friction_score: s.frictionScore ?? '',
    repo: s.repoName ?? '',
    session_id: s.sessionId,
    shape_label: s.shapeLabel ?? '',
    started_at: s.startedAt.toISOString(),
    status: s.status,
  }));

  const csv = toCSV(rows);
  return new NextResponse(csv, {
    headers: {
      'Content-Disposition': 'attachment; filename="sessions.csv"',
      'Content-Type': 'text/csv; charset=utf-8',
    },
  });
}
