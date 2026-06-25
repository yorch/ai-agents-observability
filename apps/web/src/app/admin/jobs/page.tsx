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
        <p className="text-xs text-white/40 uppercase tracking-wider mb-1">Admin</p>
        <h1 className="text-2xl font-semibold">Scheduled Jobs</h1>
        <p className="mt-1 text-sm text-white/50">
          Toggle, reschedule, and manually trigger nightly jobs. Changes take effect on the next
          60-second scheduler poll.
        </p>
      </div>

      {configs.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-8 text-center">
          <p className="text-sm text-white/50">
            No job configs yet — they appear once the ingest service starts and seeds the defaults.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-white/10 bg-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-white/40 text-left">
                <th className="px-4 py-3 font-medium">Job</th>
                <th className="px-4 py-3 font-medium">Enabled</th>
                <th className="px-4 py-3 font-medium">Schedule (UTC)</th>
                <th className="px-4 py-3 font-medium">Last run</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {configs.map((cfg) => {
                const run = runByJob.get(cfg.jobName);
                return (
                  <tr key={cfg.jobName}>
                    <td className="px-4 py-4 font-mono text-xs text-white/80">{cfg.jobName}</td>

                    {/* Enabled + schedule form — submitted together */}
                    <td className="px-4 py-4" colSpan={2}>
                      <form action={updateJobConfig} className="flex items-center gap-4 flex-wrap">
                        <input type="hidden" name="jobName" value={cfg.jobName} />
                        <label
                          htmlFor={`enabled-${cfg.jobName}`}
                          className="flex items-center gap-2 text-xs text-white/70 cursor-pointer"
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
                          className="flex items-center gap-1 text-xs text-white/70"
                        >
                          Hour
                          <select
                            id={`hour-${cfg.jobName}`}
                            name="runHourUtc"
                            defaultValue={cfg.runHourUtc}
                            className="ml-1 rounded bg-white/10 border border-white/10 px-1 py-0.5 text-white text-xs"
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
                          className="flex items-center gap-1 text-xs text-white/70"
                        >
                          Min
                          <select
                            id={`min-${cfg.jobName}`}
                            name="runMinuteUtc"
                            defaultValue={cfg.runMinuteUtc}
                            className="ml-1 rounded bg-white/10 border border-white/10 px-1 py-0.5 text-white text-xs"
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
                          className="rounded px-2 py-1 text-xs bg-white/10 hover:bg-white/20 text-white/80"
                        >
                          Save
                        </button>
                      </form>
                    </td>

                    <td className="px-4 py-4 text-xs text-white/50">
                      {run
                        ? `${run.startedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`
                        : '—'}
                    </td>

                    <td className="px-4 py-4">
                      {run ? (
                        <StatusBadge status={run.status} />
                      ) : (
                        <span className="text-white/30 text-xs">—</span>
                      )}
                    </td>

                    <td className="px-4 py-4">
                      <form action={triggerJob}>
                        <input type="hidden" name="jobName" value={cfg.jobName} />
                        <button
                          type="submit"
                          className="rounded px-3 py-1 text-xs font-medium bg-brand-500 hover:bg-brand-600 text-bg"
                        >
                          Run now
                        </button>
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

function StatusBadge({ status }: { status: string }) {
  const classes =
    status === 'success'
      ? 'bg-green-500/20 text-green-300 border-green-500/30'
      : status === 'running'
        ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
        : status === 'error'
          ? 'bg-red-500/20 text-red-300 border-red-500/30'
          : 'bg-white/10 text-white/50 border-white/10';
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${classes}`}>
      {status}
    </span>
  );
}
