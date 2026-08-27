import { CostAttributionNote } from '@/components/CostAttributionNote';
import { PageHeader } from '@/components/team-org/PageHeader';
import { Card, EmptyState, SectionHeader, Stat, Table } from '@/components/ui';
import { getAttributionCoverage } from '@/lib/attribution-coverage';
import { fmtUsdOrDash } from '@/lib/fmt';
import { requireTeamLead } from '@/lib/roles';
import {
  getTeamSkillUsage,
  getTeamToolCategoryBreakdown,
  getTeamToolStats,
  resolveTeamVisibility,
} from '@/lib/team-queries';
import { daysAgo } from '@/lib/time';

export const dynamic = 'force-dynamic';

export default async function TeamToolsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { slug } = await params;
  const { range: rangeParam } = await searchParams;
  const range = ([7, 30, 90].includes(Number(rangeParam)) ? Number(rangeParam) : 30) as 7 | 30 | 90;

  const { teamId, teamName } = await requireTeamLead(slug);
  const since = daysAgo(range);

  const { visibleIds } = await resolveTeamVisibility(teamId);
  const [tools, categories, skills, coverage] = await Promise.all([
    getTeamToolStats(visibleIds, since),
    getTeamToolCategoryBreakdown(visibleIds, since),
    getTeamSkillUsage(visibleIds, since),
    getAttributionCoverage(visibleIds, since),
  ]);

  const totalCalls = tools.reduce((s, r) => s + r.callCount, 0);
  const totalDenied = tools.reduce((s, r) => s + r.denyCount, 0);
  const denyRate = totalCalls > 0 ? totalDenied / totalCalls : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        breadcrumb="Team"
        description={`Tool & skill usage · trailing ${range} days`}
        range={range}
        title={teamName}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Tool calls" value={totalCalls.toLocaleString()} />
        <Stat label="Unique tools" value={tools.length.toString()} />
        <Stat label="Denial rate" value={`${(denyRate * 100).toFixed(1)}%`} />
      </div>

      {categories.length > 0 && (
        <Card>
          <SectionHeader>By category</SectionHeader>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <div
                key={c.category}
                className="flex items-center gap-2 rounded bg-surface-2 px-3 py-1.5 text-sm"
              >
                <span className="capitalize text-text">{c.category}</span>
                <span className="font-mono text-xs text-text-2">
                  {c.callCount.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {tools.length > 0 ? (
        <Card>
          <SectionHeader>Top tools</SectionHeader>
          <Table
            columns={[
              { label: 'Tool' },
              { align: 'right', label: 'Calls', mono: true },
              { align: 'right', label: 'Denied', mono: true },
              { align: 'right', label: 'Deny %', mono: true },
              { align: 'right', label: 'Avg ms', mono: true },
              { align: 'right', label: 'Users', mono: true },
              // P14-004: two lenses on the same dollars, never a total.
              { align: 'right', label: 'Turn share', mono: true },
              { align: 'right', label: 'Downstream', mono: true },
            ]}
          >
            {tools.map((r) => (
              <tr key={r.toolName} className="border-b border-border-subtle">
                <td className="py-2 font-mono text-text">{r.toolName}</td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.callCount.toLocaleString()}
                </td>
                <td
                  className={`py-2 text-right font-mono ${r.denyCount > 0 ? 'text-warn' : 'text-text-3'}`}
                >
                  {r.denyCount > 0 ? r.denyCount : '—'}
                </td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.denyRate > 0 ? `${(r.denyRate * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.avgDurationMs !== null ? r.avgDurationMs : '—'}
                </td>
                <td className="py-2 text-right font-mono text-text-2">{r.distinctUsers}</td>
                <td className="py-2 text-right font-mono text-text-2">
                  {fmtUsdOrDash(r.attributedCostUsd)}
                </td>
                <td className="py-2 text-right font-mono text-text-2">
                  {fmtUsdOrDash(r.downstreamCostUsd)}
                </td>
              </tr>
            ))}
          </Table>
          <CostAttributionNote className="mt-3" coverage={coverage} />
        </Card>
      ) : (
        <EmptyState>No tool activity in this period</EmptyState>
      )}

      {skills.length > 0 && (
        <Card>
          <SectionHeader>Skills &amp; slash commands</SectionHeader>
          <Table
            columns={[
              { label: 'Name' },
              { label: 'Type' },
              { align: 'right', label: 'Invocations', mono: true },
              { align: 'right', label: 'Users', mono: true },
              // The pre-P14-004 session proxy, kept beside the real numbers.
              { align: 'right', label: 'Avg session $', mono: true },
              { align: 'right', label: 'Turn share', mono: true },
              { align: 'right', label: 'Downstream', mono: true },
            ]}
          >
            {skills.map((r) => (
              <tr key={`${r.kind}:${r.name}`} className="border-b border-border-subtle">
                <td className="py-2 font-mono text-text">/{r.name}</td>
                <td className="py-2 text-xs capitalize text-text-3">{r.kind}</td>
                <td className="py-2 text-right font-mono text-text-2">{r.callCount}</td>
                <td className="py-2 text-right font-mono text-text-2">{r.distinctUsers}</td>
                <td className="py-2 text-right font-mono text-text-2">
                  {r.avgSessionCostUsd !== null ? `$${r.avgSessionCostUsd.toFixed(3)}` : '—'}
                </td>
                <td className="py-2 text-right font-mono text-text-2">
                  {fmtUsdOrDash(r.attributedCostUsd)}
                </td>
                <td className="py-2 text-right font-mono text-text-2">
                  {fmtUsdOrDash(r.downstreamCostUsd)}
                </td>
              </tr>
            ))}
          </Table>
          <CostAttributionNote className="mt-3" coverage={coverage} />
        </Card>
      )}
    </div>
  );
}
