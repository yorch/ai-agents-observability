import {
  ActionForm,
  Badge,
  type BadgeTone,
  Button,
  Card,
  Cell,
  EmptyState,
  Row,
  Select,
  Table,
} from '@/components/ui';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

import { triggerJob, updateJobConfig } from './actions';

const pad = (n: number) => String(n).padStart(2, '0');
// The same on every row — only each `Select`'s `defaultValue` differs.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => (
  <option key={i} value={i}>
    {pad(i)}
  </option>
));
const MINUTE_OPTIONS = [0, 15, 30, 45].map((m) => (
  <option key={m} value={m}>
    {pad(m)}
  </option>
));

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
        <Card>
          <Table
            columns={[
              { label: 'Job' },
              { label: 'Enabled' },
              { label: 'Schedule (UTC)' },
              { label: 'Last run' },
              { label: 'Status' },
              { label: 'Actions' },
            ]}
          >
            {configs.map((cfg) => {
              const run = runByJob.get(cfg.jobName);
              // A manual "Run now" that the scheduler hasn't picked up yet: the
              // request is newer than the latest run (or there is no run at all).
              const queued =
                cfg.runRequestedAt != null && (!run || cfg.runRequestedAt > run.startedAt);
              return (
                <Row key={cfg.jobName}>
                  <Cell className="text-xs text-text">{cfg.jobName}</Cell>

                  {/* Enabled + schedule form — submitted together */}
                  <Cell colSpan={2}>
                    <ActionForm
                      action={updateJobConfig}
                      className="flex items-center gap-4 flex-wrap"
                    >
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
                        <Select
                          size="sm"
                          id={`hour-${cfg.jobName}`}
                          name="runHourUtc"
                          defaultValue={cfg.runHourUtc}
                        >
                          {HOUR_OPTIONS}
                        </Select>
                      </label>

                      <label
                        htmlFor={`min-${cfg.jobName}`}
                        className="flex items-center gap-1 text-xs text-text-2"
                      >
                        Min
                        <Select
                          size="sm"
                          id={`min-${cfg.jobName}`}
                          name="runMinuteUtc"
                          defaultValue={cfg.runMinuteUtc}
                        >
                          {MINUTE_OPTIONS}
                        </Select>
                      </label>

                      <Button size="sm" variant="secondary" type="submit">
                        Save
                      </Button>
                    </ActionForm>
                  </Cell>

                  <Cell className="text-xs text-text-2">
                    {run
                      ? `${run.startedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`
                      : '—'}
                  </Cell>

                  <Cell>
                    {/* A queued manual run renders BESIDE the last outcome, never in
                        place of it — replacing a failed badge with a neutral "queued"
                        would mask exactly the state the admin is debugging. */}
                    {run || queued ? (
                      <span className="flex items-center gap-1.5">
                        {run ? <StatusBadge status={run.status} /> : null}
                        {queued ? <Badge tone="neutral">queued</Badge> : null}
                      </span>
                    ) : (
                      <span className="text-text-3 text-xs">—</span>
                    )}
                  </Cell>

                  <Cell>
                    <ActionForm action={triggerJob}>
                      <input type="hidden" name="jobName" value={cfg.jobName} />
                      <Button size="sm" type="submit">
                        Run now
                      </Button>
                    </ActionForm>
                  </Cell>
                </Row>
              );
            })}
          </Table>
        </Card>
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
