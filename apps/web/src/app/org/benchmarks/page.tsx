import { TriangleDownIcon, TriangleUpIcon } from '@/components/icons';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Card, Cell, Row, Table } from '@/components/ui';
import { getTeamBenchmarks } from '@/lib/org-queries';
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
export const dynamic = 'force-dynamic';

function delta(value: number, median: number, lowerIsBetter = false): 'above' | 'below' | 'at' {
  const pct = median > 0 ? Math.abs(value - median) / median : 0;
  if (pct < 0.1) {
    return 'at';
  }
  const better = lowerIsBetter ? value < median : value > median;
  return better ? 'above' : 'below';
}

function DeltaBadge({
  label,
  lowerIsBetter = false,
  median,
  value,
}: {
  label: string;
  lowerIsBetter?: boolean;
  median: number;
  value: number;
}) {
  const dir = delta(value, median, lowerIsBetter);
  const color = dir === 'above' ? 'text-good' : dir === 'below' ? 'text-crit' : 'text-text-2';
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs ${color}`}
      title={`Org median: ${median}`}
    >
      {label}
      {dir === 'above' ? (
        <TriangleUpIcon size={9} />
      ) : dir === 'below' ? (
        <TriangleDownIcon size={9} />
      ) : (
        <span className="text-[10px]">–</span>
      )}
    </span>
  );
}

export default async function OrgBenchmarksPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const { orgRole } = await requireOrgViewer();
  const isAdmin = isOrgAdmin(orgRole);

  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;
  const weeks = Math.round(range / 7);
  const since = daysAgo(range);
  const { teams, medians } = await getTeamBenchmarks(since, weeks);

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Org"
        description={`Cross-team efficiency comparison · trailing ${weeks} week${weeks !== 1 ? 's' : ''} · teams with ≥5 sessions`}
        range={range}
        title="Team Benchmarks"
      />

      {/* Org median reference */}
      <Card>
        <h2 className="mb-3 font-display text-sm font-semibold text-text">
          Org medians (baseline)
        </h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MedianCard
            label="Cost / session"
            value={medians.avgCostPerSession > 0 ? `$${medians.avgCostPerSession.toFixed(3)}` : '—'}
          />
          <MedianCard
            label="Friction p50"
            value={medians.frictionP50 != null ? medians.frictionP50.toFixed(2) : '—'}
          />
          <MedianCard
            label="Sessions / user / wk"
            value={medians.sessionsPerUserPerWeek.toFixed(1)}
          />
          <MedianCard
            label="Tool success rate"
            value={`${(medians.toolSuccessRate * 100).toFixed(1)}%`}
          />
        </div>
        <p className="inline-flex flex-wrap items-center gap-1 text-xs text-text-3 mt-3">
          Direction markers (<TriangleUpIcon size={9} className="text-good" /> /
          <TriangleDownIcon size={9} className="text-crit" />) in the table below indicate whether
          each team is above or below these org medians.
          <TriangleUpIcon size={9} className="text-good" /> = better than median (lower cost, lower
          friction, higher activity, higher success).
        </p>
      </Card>

      {/* Benchmark table */}
      {teams.length === 0 ? (
        <Card>
          <p className="text-sm text-text-3">
            No team data yet. Teams need ≥5 sessions from org-sharing users in the last {weeks}{' '}
            weeks to appear here.
          </p>
        </Card>
      ) : (
        <Card title="Team comparison" contentClassName="space-y-3">
          <Table
            columns={[
              { label: 'Team' },
              { align: 'right', label: 'Sessions' },
              { align: 'right', label: 'Users' },
              { align: 'right', label: 'Sess/user/wk' },
              { align: 'right', label: 'Cost/session' },
              { align: 'right', label: 'Friction p50' },
              { align: 'right', label: 'Tool success' },
            ]}
          >
            {teams.map((t) => (
              <Row key={t.teamSlug}>
                <Cell>
                  {isAdmin ? (
                    <a href={`/team/${t.teamSlug}`} className="text-accent hover:underline">
                      {t.teamName}
                    </a>
                  ) : (
                    t.teamName
                  )}
                </Cell>
                <Cell num className="text-text-2">
                  {t.sessionCount}
                </Cell>
                <Cell num className="text-text-2">
                  {t.userCount}
                </Cell>
                <Cell num>
                  <DeltaBadge
                    label={t.sessionsPerUserPerWeek.toFixed(1)}
                    median={medians.sessionsPerUserPerWeek}
                    value={t.sessionsPerUserPerWeek}
                    lowerIsBetter={false}
                  />
                </Cell>
                <Cell num>
                  <DeltaBadge
                    label={`$${t.avgCostPerSession.toFixed(3)}`}
                    median={medians.avgCostPerSession}
                    value={t.avgCostPerSession}
                    lowerIsBetter={true}
                  />
                </Cell>
                <Cell num>
                  {t.frictionP50 != null ? (
                    <DeltaBadge
                      label={t.frictionP50.toFixed(2)}
                      median={medians.frictionP50 ?? 0}
                      value={t.frictionP50}
                      lowerIsBetter={true}
                    />
                  ) : (
                    <span className="text-text-3 text-xs">—</span>
                  )}
                </Cell>
                <Cell num>
                  <DeltaBadge
                    label={`${(t.toolSuccessRate * 100).toFixed(1)}%`}
                    median={medians.toolSuccessRate}
                    value={t.toolSuccessRate}
                    lowerIsBetter={false}
                  />
                </Cell>
              </Row>
            ))}
          </Table>
        </Card>
      )}

      <Card className="text-xs text-text-3" contentClassName="space-y-2">
        <p className="font-semibold text-text-2">Metric definitions</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>
            <strong className="text-text-2">Sessions/user/wk</strong> — average sessions per team
            member per week. Higher = more active use.
          </li>
          <li>
            <strong className="text-text-2">Cost/session</strong> — mean LLM cost per session. Lower
            = more efficient prompting or lighter workloads.
          </li>
          <li>
            <strong className="text-text-2">Friction p50</strong> — median friction score (0–1):
            composite of deny rate, error rate, interrupt rate. Lower = smoother sessions. Null =
            fewer than 2 scored sessions.
          </li>
          <li>
            <strong className="text-text-2">Tool success rate</strong> — 1 − (tool errors / tool
            calls). Higher = fewer tool failures.
          </li>
        </ul>
        <p className="pt-1">
          Only teams with ≥5 sessions from org-sharing users in the last {weeks} weeks are shown.
          Benchmarks compare within the org, not against external baselines.
        </p>
      </Card>
    </div>
  );
}

function MedianCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-text-3">{label}</p>
      <p className="text-lg font-semibold font-mono">{value}</p>
    </div>
  );
}
