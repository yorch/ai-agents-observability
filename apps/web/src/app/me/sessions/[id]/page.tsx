import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { currentUser } from '@/lib/auth';
import type {
  ModelBreakdownRow,
  SessionSkillRow,
  SessionSubagentRow,
  SessionToolRow,
} from '@/lib/sessions-queries';
import {
  getSession,
  getSessionEvents,
  getSessionModelBreakdown,
  getSessionSkills,
  getSessionToolBreakdown,
} from '@/lib/sessions-queries';

export const dynamic = 'force-dynamic';

type PageParams = { id: string };
type SearchParams = { tab?: string };

export default async function SessionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<PageParams>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/login');
  }

  const { id } = await params;
  const { tab = 'timeline' } = await searchParams;

  const noTools = { subagents: [] as SessionSubagentRow[], tools: [] as SessionToolRow[] };
  const [session, modelBreakdown, sessionEvents, skillRows, toolBreakdown] = await Promise.all([
    getSession(user.id, id),
    tab === 'models'
      ? getSessionModelBreakdown(user.id, id)
      : Promise.resolve([] as ModelBreakdownRow[]),
    tab === 'timeline' ? getSessionEvents(user.id, id) : Promise.resolve([]),
    tab === 'skills' ? getSessionSkills(user.id, id) : Promise.resolve([] as SessionSkillRow[]),
    tab === 'tools' ? getSessionToolBreakdown(user.id, id) : Promise.resolve(noTools),
  ]);
  if (!session) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <Link href="/me/sessions" className="text-sm text-text-3 hover:text-accent transition-colors">
        ← Sessions
      </Link>

      <SessionDetailHeader
        session={session}
        transcriptHref={session.transcriptS3Key ? `/me/sessions/${id}/transcript` : null}
      />

      <SessionDetailTabs
        events={sessionEvents}
        modelBreakdown={modelBreakdown}
        session={session}
        skillRows={skillRows}
        subagentRows={toolBreakdown.subagents}
        tab={tab}
        toolRows={toolBreakdown.tools}
      />
    </div>
  );
}
