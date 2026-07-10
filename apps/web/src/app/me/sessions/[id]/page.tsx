import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { SessionFeedbackForm } from '@/components/me/SessionFeedbackForm';
import { SessionPRLinks } from '@/components/me/SessionPRLinks';
import { ShareSessionButton } from '@/components/me/ShareSessionButton';
import { currentUser } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { getPrisma } from '@/lib/prisma';
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
  const [session, modelBreakdown, sessionEvents, skillRows, toolBreakdown, rawShares] =
    await Promise.all([
      getSession(user.id, id),
      tab === 'models'
        ? getSessionModelBreakdown(user.id, id)
        : Promise.resolve([] as ModelBreakdownRow[]),
      tab === 'timeline' ? getSessionEvents(user.id, id) : Promise.resolve([]),
      tab === 'skills' ? getSessionSkills(user.id, id) : Promise.resolve([] as SessionSkillRow[]),
      tab === 'tools' ? getSessionToolBreakdown(user.id, id) : Promise.resolve(noTools),
      getPrisma().accessGrant.findMany({
        select: { expiresAt: true, grantee: { select: { email: true } }, id: true },
        where: {
          expiresAt: { gt: new Date() },
          grantedAt: { not: null },
          revokedAt: null,
          targetSessionId: id,
        },
      }),
    ]);
  if (!session) {
    notFound();
  }

  // R11: owner's existing feedback on this session, if any — plus the
  // correlation panel's data (linked PRs, Jira key, repo context).
  const [feedback, prLinkRows, correlation] = await Promise.all([
    getPrisma().sessionFeedback.findUnique({
      select: { note: true, sentiment: true },
      where: { sessionId_userId: { sessionId: id, userId: user.id } },
    }),
    getPrisma().sessionPRLink.findMany({
      orderBy: { prNumber: 'asc' },
      select: {
        linkSource: true,
        prNumber: true,
        pullRequest: { select: { state: true, title: true } },
      },
      where: { sessionId: id },
    }),
    getPrisma().session.findFirst({
      select: { jiraKey: true, repoId: true },
      where: { sessionId: id, userId: user.id },
    }),
  ]);

  const jiraBase = getConfig().jiraBaseUrl?.replace(/\/$/, '') ?? null;
  const prLinks = prLinkRows.map((l) => ({
    linkSource: l.linkSource as string,
    prNumber: l.prNumber,
    prState: l.pullRequest.state as string,
    prTitle: l.pullRequest.title,
  }));

  const activeShares = rawShares
    .filter((s): s is typeof s & { expiresAt: Date } => s.expiresAt !== null)
    .map((s) => ({ expiresAt: s.expiresAt, granteeEmail: s.grantee.email, id: s.id }));

  return (
    <div className="space-y-6">
      <Link href="/me/sessions" className="text-sm text-text-3 hover:text-accent transition-colors">
        ← Sessions
      </Link>

      <SessionDetailHeader
        extra={<ShareSessionButton activeShares={activeShares} sessionId={id} />}
        session={session}
        transcriptHref={session.transcriptS3Key ? `/me/sessions/${id}/transcript` : null}
      />

      <SessionFeedbackForm
        sessionId={id}
        initialSentiment={
          feedback?.sentiment === 'up' || feedback?.sentiment === 'down' ? feedback.sentiment : null
        }
        initialNote={feedback?.note ?? null}
      />

      <SessionPRLinks
        canLink={correlation?.repoId != null}
        jiraBase={jiraBase}
        jiraKey={correlation?.jiraKey ?? null}
        links={prLinks}
        repoName={session.repoName}
        sessionId={id}
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
