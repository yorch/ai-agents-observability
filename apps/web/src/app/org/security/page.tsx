import { AuditAction } from '@ai-agents-observability/db';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Badge, type BadgeTone, Card, Cell, Row, Stat, Table } from '@/components/ui';
import { fmtBytes } from '@/lib/fmt';
import { getPrisma } from '@/lib/prisma';
import { requireOrgViewer } from '@/lib/roles';
import {
  type CategoryExposureRow,
  getCategoryExposure,
  getEgressServers,
  getLargeOutputEvents,
  getRedactionExposure,
  getRepoExposure,
} from '@/lib/security-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

// Security & compliance posture (Tier 2). An aggregate, visibility-scoped view of
// the AI-agent data-flow surface the platform already captures: powerful tool
// categories and where they ran, external services reached via MCP, unusually
// large data movements, and the privileged-access audit trail. No individual
// developer's activity is exposed — every event query is scoped to org-metadata
// sharers, and drill-downs go through the standard audited session paths.

const CATEGORY_META: Record<string, { label: string; risk: 'high' | 'med' | 'low' }> = {
  exec: { label: 'Code execution', risk: 'high' },
  fs_read: { label: 'File reads', risk: 'low' },
  fs_write: { label: 'File writes', risk: 'med' },
  mcp: { label: 'MCP calls', risk: 'med' },
  other: { label: 'Other', risk: 'low' },
  search: { label: 'Search', risk: 'low' },
  task: { label: 'Subagent tasks', risk: 'low' },
  web: { label: 'Network / web', risk: 'high' },
};

const RISK_TONE: Record<string, BadgeTone> = {
  high: 'crit',
  low: 'neutral',
  med: 'warn',
};

// Keyed by the redaction rule names persisted in sessions.redaction_flags (see
// packages/redaction) — kebab-case, not the snake_case these labels once used
// (which never matched, so the table fell back to raw class names).
const REDACTION_CLASS_LABELS: Record<string, string> = {
  'aws-access-key': 'AWS access key',
  'aws-secret-key': 'AWS secret key',
  email: 'Email address',
  'env-secret': 'Generic secret / .env',
  'git-remote-url': 'URL credentials',
  'github-token': 'GitHub token',
  jwt: 'JWT',
  'private-key': 'Private key',
  'slack-token': 'Slack token',
};

export default async function OrgSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireOrgViewer();

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const since = daysAgo(range);
  const db = getPrisma();

  const [
    categories,
    repoExposure,
    egress,
    largeOutputs,
    redaction,
    transcriptViews,
    sessionViews,
    exports,
  ] = await Promise.all([
    getCategoryExposure(since),
    getRepoExposure(since),
    getEgressServers(since),
    getLargeOutputEvents(since),
    getRedactionExposure(since),
    db.auditLog.count({ where: { action: AuditAction.VIEW_TRANSCRIPT, ts: { gte: since } } }),
    db.auditLog.count({ where: { action: AuditAction.VIEW_SESSION, ts: { gte: since } } }),
    db.auditLog.count({
      where: {
        action: { in: [AuditAction.EXPORT_TEAM, AuditAction.EXPORT_ORG] },
        ts: { gte: since },
      },
    }),
  ]);

  const highRiskCalls = categories
    .filter((c) => CATEGORY_META[c.category]?.risk === 'high')
    .reduce((s, c) => s + c.totalCalls, 0);
  const totalEgressCalls = egress.reduce((s, e) => s + e.totalCalls, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`AI-agent data-flow & access posture · trailing ${range} days · aggregate, no individual content`}
        range={range}
        title="Security"
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="High-risk tool calls"
          value={highRiskCalls.toLocaleString()}
          sub="code execution + network"
          accent={highRiskCalls > 0 ? 'warn' : undefined}
        />
        <Stat
          label="External services (MCP)"
          value={egress.length.toString()}
          sub={`${totalEgressCalls.toLocaleString()} egress calls`}
        />
        <Stat
          label="Privileged views"
          value={(transcriptViews + sessionViews).toLocaleString()}
          sub={`${transcriptViews} transcript · ${sessionViews} session`}
        />
        <Stat label="Data exports" value={exports.toLocaleString()} sub="team + org" />
      </div>

      {/* Tool-category exposure */}
      <Card
        title="Tool-category exposure"
        caption="What kinds of powerful access the agents used, and how widely."
        contentClassName="space-y-3"
      >
        {categories.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-3">No tool activity in this period.</p>
        ) : (
          <CategoryTable rows={categories} />
        )}
      </Card>

      {/* Per-repo exposure */}
      <Card
        title="Exposure by repo"
        caption="Repos ranked by code-execution and network egress — where a data-exposure review starts."
        contentClassName="space-y-3"
      >
        {repoExposure.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-3">
            No exec/web/write activity in this period.
          </p>
        ) : (
          <Table
            columns={[
              { label: 'Repo' },
              { align: 'right', label: 'Exec' },
              { align: 'right', label: 'Network' },
              { align: 'right', label: 'Writes' },
            ]}
          >
            {repoExposure.map((r) => (
              <Row key={r.repoName}>
                <Cell className="text-xs text-text">{r.repoName}</Cell>
                <Cell num className="text-crit">
                  {r.execCalls.toLocaleString()}
                </Cell>
                <Cell num className="text-crit">
                  {r.webCalls.toLocaleString()}
                </Cell>
                <Cell num className="text-text-2">
                  {r.writeCalls.toLocaleString()}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      {/* External egress */}
      <Card
        title="External egress (MCP servers)"
        caption="Each MCP server is an external service the agents reached — an egress inventory for security review."
        contentClassName="space-y-3"
      >
        {egress.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-3">No MCP calls in this period.</p>
        ) : (
          <Table
            columns={[
              { label: 'Server' },
              { align: 'right', label: 'Calls' },
              { align: 'right', label: 'Users' },
              { align: 'right', label: 'Repos' },
              { align: 'right', label: 'Data out' },
            ]}
          >
            {egress.map((e) => (
              <Row key={e.server}>
                <Cell className="text-xs text-text">{e.server}</Cell>
                <Cell num className="text-text-2">
                  {e.totalCalls.toLocaleString()}
                </Cell>
                <Cell num className="text-text-2">
                  {e.distinctUsers}
                </Cell>
                <Cell num className="text-text-2">
                  {e.distinctRepos}
                </Cell>
                <Cell num className="text-text-2">
                  {fmtBytes(e.totalOutputBytes)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      {/* Secret exposure by class */}
      <Card
        title="Secret exposure by class"
        caption="Sessions whose shipped transcript matched a redaction class before it hit storage. Forward-looking only — historical transcripts are not backfilled."
        contentClassName="space-y-3"
      >
        <p className="text-xs text-text-2">
          <span className="font-mono text-text">{redaction.sessionsWithSecrets}</span> of{' '}
          <span className="font-mono text-text">{redaction.totalSessionsWithTranscript}</span>{' '}
          transcripts in this window matched a redaction class.
        </p>
        {redaction.classes.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-3">
            No redaction classes recorded in this period. Capture began when the{' '}
            <code className="font-mono text-text-2">redaction_flags</code> column was added;
            historical transcripts are not backfilled.
          </p>
        ) : (
          <Table columns={[{ label: 'Class' }, { align: 'right', label: 'Sessions' }]}>
            {redaction.classes.map((c) => (
              <Row key={c.redactionClass}>
                <Cell className="text-text">
                  {REDACTION_CLASS_LABELS[c.redactionClass] ?? c.redactionClass}
                </Cell>
                <Cell num className="text-crit">
                  {c.sessionCount.toLocaleString()}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      {/* Large data movements */}
      <Card
        title="Largest data movements"
        caption="Biggest single tool outputs on network / MCP / file-read — the rows to eyeball first. Sizes only; no content is stored."
        contentClassName="space-y-3"
      >
        {largeOutputs.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-3">
            No sized tool outputs in this period.
          </p>
        ) : (
          <Table
            columns={[
              { label: 'When' },
              { label: 'Tool' },
              { label: 'Repo' },
              { align: 'right', label: 'Output' },
            ]}
          >
            {largeOutputs.map((r, i) => (
              <Row key={`${r.sessionId}-${i}`}>
                <Cell className="text-xs text-text-2">
                  {r.ts.toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
                </Cell>
                <Cell className="text-xs">
                  <span className="font-mono text-text">{r.toolName ?? '—'}</span>
                  {r.category && <span className="ml-1.5 text-text-3">{r.category}</span>}
                </Cell>
                <Cell className="text-xs text-text-2">{r.repoName ?? '—'}</Cell>
                <Cell num className="text-warn">
                  {fmtBytes(r.outputBytes)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Card>

      <p className="text-xs text-text-3 text-center pt-2">
        Aggregate and visibility-scoped: only developers who share metadata with the org contribute,
        and no tool inputs/outputs are stored — the events firehose keeps hashes and byte sizes
        only.
      </p>
    </div>
  );
}

function CategoryTable({ rows }: { rows: CategoryExposureRow[] }) {
  const maxCalls = Math.max(...rows.map((r) => r.totalCalls), 1);
  return (
    <Table
      columns={[
        { label: 'Category' },
        { label: 'Risk' },
        { label: 'Volume' },
        { align: 'right', label: 'Calls' },
        { align: 'right', label: 'Users' },
        { align: 'right', label: 'Repos' },
      ]}
    >
      {rows.map((r) => {
        const meta = CATEGORY_META[r.category] ?? { label: r.category, risk: 'low' as const };
        return (
          <Row key={r.category}>
            <Cell className="text-text">{meta.label}</Cell>
            <Cell>
              <Badge tone={RISK_TONE[meta.risk] ?? 'neutral'}>{meta.risk}</Badge>
            </Cell>
            <Cell className="w-1/3">
              <div className="h-1.5 rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${meta.risk === 'high' ? 'bg-crit/60' : 'bg-accent-muted'}`}
                  style={{ width: `${(r.totalCalls / maxCalls) * 100}%` }}
                />
              </div>
            </Cell>
            <Cell num className="text-text-2">
              {r.totalCalls.toLocaleString()}
            </Cell>
            <Cell num className="text-text-2">
              {r.distinctUsers}
            </Cell>
            <Cell num className="text-text-2">
              {r.distinctRepos}
            </Cell>
          </Row>
        );
      })}
    </Table>
  );
}
