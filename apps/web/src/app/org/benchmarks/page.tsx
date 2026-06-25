import { getTeamBenchmarks } from '@/lib/org-queries';
import { isOrgAdmin, requireOrgViewer } from '@/lib/roles';
import { daysAgo } from '@/lib/time';
import { OrgSubNav } from '../layout';

export const dynamic = 'force-dynamic';

const WEEKS = 4;

function delta(value: number, median: number, lowerIsBetter = false): 'above' | 'below' | 'at' {
  const pct = median > 0 ? Math.abs(value - median) / median : 0;
  if (pct < 0.1) return 'at';
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
  const color =
    dir === 'above'
      ? 'text-green-400'
      : dir === 'below'
        ? 'text-red-400'
        : 'text-white/50';
  const arrow = dir === 'above' ? '▲' : dir === 'below' ? '▼' : '–';
  return (
    <span className={`font-mono text-xs ${color}`} title={`Org median: ${median}`}>
      {label}
      <span className="ml-1 text-[10px]">{arrow}</span>
    </span>
  );
}

export default async function OrgBenchmarksPage() {
  const { orgRole } = await requireOrgViewer();
  const isAdmin = isOrgAdmin(orgRole);

  const since = daysAgo(WEEKS * 7);
  const { teams, medians } = await getTeamBenchmarks(since, WEEKS);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Org</p>
        <h1 className="text-2xl font-semibold">Team Benchmarks</h1>
        <p className="mt-1 text-sm text-white/50">
          Cross-team efficiency comparison · trailing {WEEKS} weeks · teams with ≥5 sessions
        </p>
      </div>

      <OrgSubNav active="benchmarks" />

      {/* Org median reference */}
      <section className="rounded-lg border border-white/10 bg-white/5 p-4">
        <h2 className="text-sm font-semibold text-white/70 mb-3">Org medians (baseline)</h2>
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
        <p className="text-xs text-white/30 mt-3">
          Arrows (▲ / ▼) in the table below indicate whether each team is above or below these
          org medians. ▲ = better than median (lower cost, lower friction, higher activity, higher
          success).
        </p>
      </section>

      {/* Benchmark table */}
      {teams.length === 0 ? (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4">
          <p className="text-sm text-white/40">
            No team data yet. Teams need ≥5 sessions from org-sharing users in the last {WEEKS}{' '}
            weeks to appear here.
          </p>
        </section>
      ) : (
        <section className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white/70">Team comparison</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-white/40 text-left">
                  <th className="pb-2 pr-4 font-medium">Team</th>
                  <th className="pb-2 font-medium text-right">Sessions</th>
                  <th className="pb-2 font-medium text-right">Users</th>
                  <th className="pb-2 font-medium text-right">Sess/user/wk</th>
                  <th className="pb-2 font-medium text-right">Cost/session</th>
                  <th className="pb-2 font-medium text-right">Friction p50</th>
                  <th className="pb-2 font-medium text-right">Tool success</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {teams.map((t) => (
                  <tr key={t.teamSlug}>
                    <td className="py-2 pr-4">
                      {isAdmin ? (
                        <a
                          href={`/team/${t.teamSlug}`}
                          className="text-brand-400 hover:underline"
                        >
                          {t.teamName}
                        </a>
                      ) : (
                        t.teamName
                      )}
                    </td>
                    <td className="py-2 text-right text-white/60">{t.sessionCount}</td>
                    <td className="py-2 text-right text-white/60">{t.userCount}</td>
                    <td className="py-2 text-right">
                      <DeltaBadge
                        label={t.sessionsPerUserPerWeek.toFixed(1)}
                        median={medians.sessionsPerUserPerWeek}
                        value={t.sessionsPerUserPerWeek}
                        lowerIsBetter={false}
                      />
                    </td>
                    <td className="py-2 text-right">
                      <DeltaBadge
                        label={`$${t.avgCostPerSession.toFixed(3)}`}
                        median={medians.avgCostPerSession}
                        value={t.avgCostPerSession}
                        lowerIsBetter={true}
                      />
                    </td>
                    <td className="py-2 text-right">
                      {t.frictionP50 != null ? (
                        <DeltaBadge
                          label={t.frictionP50.toFixed(2)}
                          median={medians.frictionP50 ?? 0}
                          value={t.frictionP50}
                          lowerIsBetter={true}
                        />
                      ) : (
                        <span className="text-white/30 text-xs">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <DeltaBadge
                        label={`${(t.toolSuccessRate * 100).toFixed(1)}%`}
                        median={medians.toolSuccessRate}
                        value={t.toolSuccessRate}
                        lowerIsBetter={false}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-2 text-xs text-white/40">
        <p className="font-semibold text-white/60">Metric definitions</p>
        <ul className="space-y-1 list-disc list-inside">
          <li>
            <strong className="text-white/50">Sessions/user/wk</strong> — average sessions per
            team member per week. Higher = more active use.
          </li>
          <li>
            <strong className="text-white/50">Cost/session</strong> — mean LLM cost per session.
            Lower = more efficient prompting or lighter workloads.
          </li>
          <li>
            <strong className="text-white/50">Friction p50</strong> — median friction score
            (0–1): composite of deny rate, error rate, interrupt rate. Lower = smoother sessions.
            Null = fewer than 2 scored sessions.
          </li>
          <li>
            <strong className="text-white/50">Tool success rate</strong> — 1 − (tool errors /
            tool calls). Higher = fewer tool failures.
          </li>
        </ul>
        <p className="pt-1">
          Only teams with ≥5 sessions from org-sharing users in the last {WEEKS} weeks are shown.
          Benchmarks compare within the org, not against external baselines.
        </p>
      </div>
    </div>
  );
}

function MedianCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-white/40">{label}</p>
      <p className="text-lg font-semibold font-mono">{value}</p>
    </div>
  );
}
