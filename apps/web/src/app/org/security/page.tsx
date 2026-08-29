import { AuditAction } from '@ai-agents-observability/db';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Badge, type BadgeTone, Card, CardEmpty, Cell, Row, Stat, Table } from '@/components/ui';
import { format } from '@/i18n/config';
import { getTranslations } from '@/i18n/server';
import { fmtBytes, fmtDayShort } from '@/lib/fmt';
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
  const { dict } = await getTranslations();

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
        description={format(dict.org.security.description, { range })}
        range={range}
        title={dict.org.security.title}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label={dict.org.security.highRiskToolCalls}
          value={highRiskCalls.toLocaleString()}
          sub={dict.org.security.highRiskToolCallsSub}
          accent={highRiskCalls > 0 ? 'warn' : undefined}
        />
        <Stat
          label={dict.org.security.externalServices}
          value={egress.length.toString()}
          sub={format(dict.org.security.externalServicesSub, {
            totalEgressCalls: totalEgressCalls.toLocaleString(),
          })}
        />
        <Stat
          label={dict.org.security.privilegedViews}
          value={(transcriptViews + sessionViews).toLocaleString()}
          sub={format(dict.org.security.privilegedViewsSub, { sessionViews, transcriptViews })}
        />
        <Stat
          label={dict.org.security.dataExports}
          value={exports.toLocaleString()}
          sub={dict.org.security.dataExportsSub}
        />
      </div>

      {/* Tool-category exposure */}
      <Card
        title={dict.org.security.toolCategoryExposure}
        caption={dict.org.security.toolCategoryExposureCaption}
        contentClassName="space-y-3"
      >
        {categories.length === 0 ? (
          <CardEmpty>{dict.org.security.emptyTool}</CardEmpty>
        ) : (
          <CategoryTable rows={categories} />
        )}
      </Card>

      {/* Per-repo exposure */}
      <Card
        title={dict.org.security.exposureByRepo}
        caption={dict.org.security.exposureByRepoCaption}
        contentClassName="space-y-3"
      >
        {repoExposure.length === 0 ? (
          <CardEmpty>{dict.org.security.emptyExecWeb}</CardEmpty>
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
        title={dict.org.security.externalEgress}
        caption={dict.org.security.externalEgressCaption}
        contentClassName="space-y-3"
      >
        {egress.length === 0 ? (
          <CardEmpty>{dict.org.security.emptyMcp}</CardEmpty>
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
        title={dict.org.security.secretExposure}
        caption={dict.org.security.secretExposureCaption}
        contentClassName="space-y-3"
      >
        <p className="text-xs text-text-2">
          {format(dict.org.security.redactionSummary, {
            totalWithTranscript: redaction.totalSessionsWithTranscript,
            withSecrets: redaction.sessionsWithSecrets,
          })}
        </p>
        {redaction.classes.length === 0 ? (
          <CardEmpty>
            {dict.org.security.redactionNote}{' '}
            <code className="font-mono text-text-2">{dict.org.security.redactionFlags}</code>{' '}
            {dict.org.security.redactionNoteSuffix}
          </CardEmpty>
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
        title={dict.org.security.largestDataMovements}
        caption={dict.org.security.largestDataMovementsCaption}
        contentClassName="space-y-3"
      >
        {largeOutputs.length === 0 ? (
          <CardEmpty>{dict.org.security.emptySized}</CardEmpty>
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
                <Cell className="text-xs text-text-2">{fmtDayShort(r.ts)}</Cell>
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

      <p className="text-xs text-text-3 text-center pt-2">{dict.org.security.footerNote}</p>
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
