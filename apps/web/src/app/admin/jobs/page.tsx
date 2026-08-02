import { Badge, type BadgeTone, Button, EmptyState } from '@/components/ui';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

import { triggerJob, updateJobConfig } from './actions';

export const dynamic = 'force-dynamic';

export default async function AdminJobsPage() {
  await requireOrgAdmin();

  const db = getPrisma();

  const [configs, recentRuns] = await Promise.all([
    db.jobConfig.findMany({ orderBy: { jobName: 'asc' } }),
    db.jobRun.findMany({
      distinct: ['jobName'],
      orderBy: { startedAt: 'desc' },
      select: { finishedAt: true, jobName: true, startedAt: true, status: true },
    }),
  ]);

  const runByJob = new Map(recentRuns.map((r) => [r.jobName, r]));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-text-3 uppercase tracking-wider mb-1">Admin</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
          Scheduled Jobs
        </h1>
        <p className="mt-1 text-sm text-text-2">
          Toggle, reschedule, and manually trigger nightly jobs. Changes take effect on the next
          60-second scheduler poll.
        </p>
      </div>

      {configs.length === 0 ? (
        <EmptyState>
          No job configs yet — they appear once the ingest service starts and seeds the defaults.
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-border bg-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-3 text-left">
                <th className="px-4 py-3 font-medium">Job</th>
                <th className="px-4 py-3 font-medium">Enabled</th>
                <th className="px-4 py-3 font-medium">Schedule (UTC)</th>
                <th className="px-4 py-3 font-medium">Last run</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {configs.map((cfg) => {
                const run = runByJob.get(cfg.jobName);
                return (
                  <tr key={cfg.jobName}>
                    <td className="px-4 py-4 font-mono text-xs text-text">{cfg.jobName}</td>

                    {/* Enabled + schedule form — submitted together */}
                    <td className="px-4 py-4" colSpan={2}>
                      <form action={updateJobConfig} className="flex items-center gap-4 flex-wrap">
                        <input type="hidden" name="jobName" value={cfg.jobName} />
                        <label
                          htmlFor={`enabled-${cfg.jobName}`}
                          className="flex items-center gap-2 text-xs text-text-2 cursor-pointer"
                        >
                          <input
                            id={`enabled-${cfg.jobName}`}
                            type="checkbox"
                            name="enabled"
                            defaultChecked={cfg.enabled}
                            className="rounded"
                          />
                          Enabled
                        </label>

                        <label
                          htmlFor={`hour-${cfg.jobName}`}
                          className="flex items-center gap-1 text-xs text-text-2"
                        >
                          Hour
                          <select
                            id={`hour-${cfg.jobName}`}
                            name="runHourUtc"
                            defaultValue={cfg.runHourUtc}
                            className="ml-1 rounded bg-surface-2 border border-border px-1 py-0.5 text-text text-xs"
                          >
                            {Array.from({ length: 24 }, (_, i) => (
                              <option key={i} value={i}>
                                {String(i).padStart(2, '0')}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label
                          htmlFor={`min-${cfg.jobName}`}
                          className="flex items-center gap-1 text-xs text-text-2"
                        >
                          Min
                          <select
                            id={`min-${cfg.jobName}`}
                            name="runMinuteUtc"
                            defaultValue={cfg.runMinuteUtc}
                            className="ml-1 rounded bg-surface-2 border border-border px-1 py-0.5 text-text text-xs"
                          >
                            {[0, 15, 30, 45].map((m) => (
                              <option key={m} value={m}>
                                {String(m).padStart(2, '0')}
                              </option>
                            ))}
                          </select>
                        </label>

                        <button
                          type="submit"
                          className="rounded px-2 py-1 text-xs bg-surface-2 hover:bg-surface-3 text-text"
                        >
                          Save
                        </button>
                      </form>
                    </td>

                    <td className="px-4 py-4 text-xs text-text-2">
                      {run
                        ? `${run.startedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`
                        : '—'}
                    </td>

                    <td className="px-4 py-4">
                      {run ? (
                        <StatusBadge status={run.status} />
                      ) : (
                        <span className="text-text-3 text-xs">—</span>
                      )}
                    </td>

                    <td className="px-4 py-4">
                      <form action={triggerJob}>
                        <input type="hidden" name="jobName" value={cfg.jobName} />
                        <Button size="sm" type="submit">
                          Run now
                        </Button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const JOB_STATUS_TONE: Record<string, BadgeTone> = {
  error: 'crit',
  running: 'accent',
  success: 'good',
};

function StatusBadge({ status }: { status: string }) {
  return <Badge tone={JOB_STATUS_TONE[status] ?? 'neutral'}>{status}</Badge>;
}
