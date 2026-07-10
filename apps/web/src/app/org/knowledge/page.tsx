import { PageHeader } from '@/components/team-org/PageHeader';
import { getKnowledgeTopics, type KnowledgeTopicRow } from '@/lib/knowledge-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// Knowledge-gap detection (Tier 2). Aggregate topic clustering over the transcript
// FTS index: which subjects developers asked the agent about most. A topic many
// sessions across many people keep hitting is a documentation / onboarding /
// tooling signal — the module 40 devs asked to explain has a docs problem.
//
// Privacy: aggregate and visibility-scoped in the query; small-n suppression here
// hides any topic that too few distinct people touched, so the view can never be
// used to infer that a specific person asked about something.
const MIN_SESSIONS = 3;
const MIN_USERS = 2;

export default async function OrgKnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 90) as 7 | 30 | 90;
  const since = daysAgo(range);
  const { topics, totalSessions } = await getKnowledgeTopics(since);

  const visible = topics.filter((t) => t.sessionCount >= MIN_SESSIONS && t.userCount >= MIN_USERS);
  const suppressed = topics.filter(
    (t) => t.sessionCount > 0 && (t.sessionCount < MIN_SESSIONS || t.userCount < MIN_USERS),
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`What developers asked agents about · trailing ${range} days · aggregate topic counts, no individual content`}
        range={range}
        title="Knowledge gaps"
      />

      {totalSessions === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm font-medium text-white/70">
            No indexed transcripts in this window.
          </p>
          <p className="mt-1 text-sm text-white/40">
            Topic clustering runs over the transcript full-text index, populated by the
            <span className="font-mono"> index-transcripts</span> ingest job. It appears here once
            transcripts have been shipped and indexed.
          </p>
        </div>
      ) : (
        <>
          <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-white/70">Topics by session reach</h2>
              <p className="mt-0.5 text-xs text-white/40">
                Share of the {totalSessions.toLocaleString()} indexed sessions whose prompts touched
                each topic. A high-reach topic is where docs, onboarding, or tooling could cut
                repeated questions.
              </p>
            </div>
            {visible.length === 0 ? (
              <p className="text-sm text-white/40">
                No topic cleared the small-n threshold ({MIN_SESSIONS}+ sessions across {MIN_USERS}+
                developers) in this window.
              </p>
            ) : (
              <div className="space-y-2.5">
                {visible.map((t) => (
                  <TopicBar key={t.id} topic={t} total={totalSessions} />
                ))}
              </div>
            )}
          </section>

          <p className="text-xs text-white/30">
            Topics are matched by a fixed keyword taxonomy over user prompts — directional, not
            exact. Counts are aggregate and visibility-scoped to org-metadata sharers; topics
            touched by fewer than {MIN_SESSIONS} sessions or {MIN_USERS} developers are suppressed
            {suppressed > 0 ? ` (${suppressed} hidden this window)` : ''}. No conversation content
            is shown — drill-down into any individual transcript still goes through the audited
            search and session paths.
          </p>
        </>
      )}
    </div>
  );
}

function TopicBar({ topic, total }: { topic: KnowledgeTopicRow; total: number }) {
  const share = total > 0 ? topic.sessionCount / total : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-white/80">{topic.label}</span>
        <span className="text-xs text-white/50">
          {topic.sessionCount.toLocaleString()} sessions · {topic.userCount} devs ·{' '}
          {(share * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-brand-500/70"
          style={{ width: `${Math.max(2, share * 100)}%` }}
        />
      </div>
    </div>
  );
}
