import { parseRubricOutcome, parseRubricShape, SCORERS } from '@ai-agents-observability/schemas';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionDetailHeader } from '@/components/me/SessionDetailHeader';
import { SessionDetailTabs } from '@/components/me/SessionDetailTabs';
import { SessionFeedbackForm } from '@/components/me/SessionFeedbackForm';
import { SessionJudgeCard } from '@/components/me/SessionJudgeCard';
import { SessionPRLinks } from '@/components/me/SessionPRLinks';
import { ShareSessionButton } from '@/components/me/ShareSessionButton';
import { currentUser } from '@/lib/auth';
import { getJiraBase } from '@/lib/config';
import { getSessionJudgeScores } from '@/lib/judge-queries';
import { getPrisma } from '@/lib/prisma';
import { readScores } from '@/lib/scores';
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

  // R11 + P13-005: owner's existing feedback on this session, if any — plus the
  // correlation panel's linked PRs (Jira key / repo come from `session` itself)
  // and, for the owner alone, any judge labels (P13-009).
  const [feedback, priorRubric, prLinkRows, judgeScores] = await Promise.all([
    getPrisma().sessionFeedback.findUnique({
      select: { note: true, sentiment: true },
      where: { sessionId_userId: { sessionId: id, userId: user.id } },
    }),
    // The rubric answers themselves live in `scores` and nowhere else — see the
    // comment on `submitSessionFeedback`. Prefilling from there rather than from
    // a mirrored column is what makes that single-store rule true end to end.
    readScores(
      {
        scorerNames: ['human_session_shape', 'human_task_outcome'],
        subjectIds: [id],
        subjectType: 'SESSION',
      },
      { kind: 'owner', ownerUserId: user.id },
    ),
    getPrisma().sessionPRLink.findMany({
      orderBy: { prNumber: 'asc' },
      select: {
        linkSource: true,
        prNumber: true,
        pullRequest: { select: { state: true, title: true } },
      },
      where: { sessionId: id },
    }),
    getSessionJudgeScores(user.id, id),
  ]);

  // Only the *current* rubric version's answer is re-shown. An answer to an
  // older version is a historical fact about a question that is no longer being
  // asked, and prefilling it would put it under today's wording.
  const priorAnswer = (scorerName: 'human_session_shape' | 'human_task_outcome') =>
    priorRubric.find(
      (r) => r.scorerName === scorerName && r.scorerVersion === SCORERS[scorerName].version,
    )?.label ?? null;

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
      <Link
        href="/me/sessions"
        className="inline-flex items-center gap-1 text-sm text-text-3 hover:text-accent transition-colors"
      >
        <ArrowLeftIcon /> Sessions
      </Link>

      <SessionDetailHeader
        extra={<ShareSessionButton activeShares={activeShares} sessionId={id} />}
        session={session}
        transcriptHref={session.transcriptS3Key ? `/me/sessions/${id}/transcript` : null}
      />

      {/*
        P13-005 blinding rule: `session` is deliberately NOT passed to this
        component. The rubric asks which shape the session was and whether it
        worked; rendering the computed `shapeLabel` / `frictionScore` beside
        those questions would turn the answers into a measure of agreement with
        the scorer instead of an independent check of it. Prior answers are
        re-shown (the developer's own words), the machine's are not. See the
        comment block in SessionFeedbackForm.tsx.
      */}
      <SessionFeedbackForm
        sessionId={id}
        initialSentiment={
          feedback?.sentiment === 'up' || feedback?.sentiment === 'down' ? feedback.sentiment : null
        }
        initialNote={feedback?.note ?? null}
        initialShape={parseRubricShape(priorAnswer('human_session_shape'))}
        initialOutcome={parseRubricOutcome(priorAnswer('human_task_outcome'))}
      />

      {/*
        P13-009: judge output is owner-visible only. This is the sole surface
        that renders it — no team or org page reads these scorers, and
        test/judge-owner-only.test.ts fails if one starts to.
      */}
      <SessionJudgeCard rows={judgeScores} />

      <SessionPRLinks
        canLink={session.repoId != null}
        jiraBase={getJiraBase()}
        jiraKey={session.jiraKey}
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
