import { PageHeader } from '@/components/team-org/PageHeader';
import { Badge, Card, CardEmpty, Cell, EmptyState, Row, Table } from '@/components/ui';
import { frictionBadge } from '@/lib/effectiveness';
import { fmtUsd } from '@/lib/fmt';
import { getPromptIntents, type PromptIntentRow } from '@/lib/prompt-queries';
import { requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// E3: Prompt pattern mining — clusters user prompts by intent and shows
// success/cost per cluster. Same trust model as /org/knowledge: aggregate,
// visibility-scoped, small-n suppressed, no conversation content shown.
const MIN_SESSIONS = 3;
const MIN_USERS = 2;

export default async function OrgPromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 90) as 7 | 30 | 90;
  const since = daysAgo(range);
  const { intents, totalSessions } = await getPromptIntents(since);

  const visible = intents.filter((i) => i.sessionCount >= MIN_SESSIONS && i.userCount >= MIN_USERS);
  const suppressed = intents.filter(
    (i) => i.sessionCount > 0 && (i.sessionCount < MIN_SESSIONS || i.userCount < MIN_USERS),
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`User prompts clustered by intent · trailing ${range} days · aggregate cost and friction per cluster`}
        range={range}
        title="Prompt patterns"
      />

      {totalSessions === 0 ? (
        <EmptyState title="No indexed transcripts in this window.">
          Prompt clustering runs over the transcript full-text index, populated by the
          <span className="font-mono"> index-transcripts</span> ingest job. It appears here once
          transcripts have been shipped and indexed.
        </EmptyState>
      ) : (
        <>
          <Card
            contentClassName="space-y-4"
            title="Intents by session reach"
            caption={`Share of the ${totalSessions.toLocaleString()} indexed sessions whose prompts matched each intent.`}
          >
            {visible.length === 0 ? (
              <CardEmpty>
                No intent cleared the small-n threshold ({MIN_SESSIONS}+ sessions across {MIN_USERS}
                + developers) in this period.
              </CardEmpty>
            ) : (
              <div className="space-y-2.5">
                {visible.map((i) => (
                  <IntentBar key={i.id} intent={i} total={totalSessions} />
                ))}
              </div>
            )}
          </Card>

          {visible.length > 0 && (
            <Card
              contentClassName="space-y-4"
              title="Cost & friction by intent"
              caption="Average cost and friction score per session for each intent cluster."
            >
              <Table
                columns={[
                  { label: 'Intent' },
                  { align: 'right', label: 'Sessions' },
                  { align: 'right', label: 'Prompts' },
                  { align: 'right', label: 'Devs' },
                  { align: 'right', label: 'Total cost' },
                  { align: 'right', label: 'Avg cost/session' },
                  { align: 'right', label: 'Avg friction' },
                ]}
              >
                {visible.map((i) => (
                  <IntentRow key={i.id} intent={i} />
                ))}
              </Table>
            </Card>
          )}

          <p className="text-xs text-text-3">
            Intents are matched by a fixed keyword taxonomy over user prompts — directional, not
            exact. A session can appear in multiple intent clusters (e.g. "write a test" matches
            both
            <span className="font-mono"> implement</span> and
            <span className="font-mono"> test</span>), so cost figures overlap and do not partition
            org spend. Counts are aggregate and visibility-scoped to org-metadata sharers; intents
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

function IntentBar({ intent, total }: { intent: PromptIntentRow; total: number }) {
  const share = total > 0 ? intent.sessionCount / total : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-text">{intent.label}</span>
        <span className="text-xs text-text-2">
          {intent.sessionCount.toLocaleString()} sessions · {intent.userCount} devs ·{' '}
          {(share * 100).toFixed(0)}%
        </span>
      </div>
      <div className="h-2 rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent-muted"
          style={{ width: `${Math.max(2, share * 100)}%` }}
        />
      </div>
    </div>
  );
}

function IntentRow({ intent }: { intent: PromptIntentRow }) {
  const friction = intent.avgFriction !== null ? frictionBadge(intent.avgFriction) : null;
  return (
    <Row>
      <Cell className="text-text">{intent.label}</Cell>
      <Cell num className="text-text-2">
        {intent.sessionCount.toLocaleString()}
      </Cell>
      <Cell num className="text-text-2">
        {intent.promptCount.toLocaleString()}
      </Cell>
      <Cell num className="text-text-2">
        {intent.userCount}
      </Cell>
      <Cell num className="text-text-2">
        {fmtUsd(intent.totalCostUsd)}
      </Cell>
      <Cell num className="text-text-2">
        {fmtUsd(intent.avgCostUsd)}
      </Cell>
      <Cell num>
        {friction ? (
          <Badge tone={friction.tone}>{friction.label}</Badge>
        ) : (
          <span className="text-text-3">—</span>
        )}
      </Cell>
    </Row>
  );
}
