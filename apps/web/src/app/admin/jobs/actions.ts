'use server';

import { revalidatePath } from 'next/cache';

import { withActionResult } from '@/lib/action-result';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

/**
 * The jobs this page may enable, reschedule, or run. Mirrors `CONFIGURABLE_JOBS`
 * in `apps/ingest/src/jobs/scheduler.ts` — the scheduler is the only reader of an
 * hour+minute cadence, so a job outside that list has no schedule for this form
 * to edit. (`apps/web` cannot import from `apps/ingest`; the shared home for a
 * definition two workspaces must agree on is `packages/schemas`.)
 *
 * **A row in `job_config` is not proof a job belongs here.** `POST
 * /admin/jobs/:name/run` on the ingest service upserts a placeholder row
 * (`enabled = false`, 00:00) for every name it accepts, so a fixed-timer or
 * operator-only job acquires a row — and therefore a row on this page — the first
 * time anyone triggers it. Without this list, ticking Enabled on one of those
 * would put it on a nightly schedule it was deliberately never given:
 *
 *   - `reprice-events-apply` is the write half of a two-name interlock. The bare
 *     `reprice-events` reports what repricing history would change; `-apply`
 *     rewrites `events.cost_usd` and moves the session/PR/cagg totals with it.
 *     The name was split precisely so that rewrite is never the default — a
 *     nightly schedule for it would undo the interlock from the UI.
 *   - `run-deletions` is the GDPR deletion job, on a fixed 6-hourly timer in the
 *     scheduler. Its cadence is not an operator setting.
 *   - `sync-teams`, `sync-jira`, `sweep-abandoned`, `sweep-scratch` and
 *     `backfill-redaction` are fixed-timer or one-shot operator drains, with no
 *     cadence to edit.
 */
const CONFIGURABLE_JOBS: ReadonlySet<string> = new Set([
  'sweep-retention',
  'index-transcripts',
  'compute-effectiveness',
  'compute-trajectory-scores',
  'compute-subject-scores',
  'link-turn-events',
  'compute-cost-attribution',
  'evaluate-alerts',
  'refresh-caggs',
  'judge-sessions',
  'send-report-digest',
]);

const pad2 = (n: number) => String(n).padStart(2, '0');

const notConfigurable = (jobName: string) => ({
  error: `"${jobName}" has no editable schedule — it runs on a fixed timer or by operator trigger only.`,
  ok: false as const,
});

export const updateJobConfig = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();
  const jobName = formData.get('jobName') as string;
  const enabled = formData.get('enabled') === 'on';
  const runHourUtc = Number(formData.get('runHourUtc'));
  const runMinuteUtc = Number(formData.get('runMinuteUtc'));
  if (
    !jobName ||
    Number.isNaN(runHourUtc) ||
    Number.isNaN(runMinuteUtc) ||
    runHourUtc < 0 ||
    runHourUtc > 23 ||
    runMinuteUtc < 0 ||
    runMinuteUtc > 59
  ) {
    return { error: 'Hour must be 0-23 and minute 0-59.', ok: false };
  }
  if (!CONFIGURABLE_JOBS.has(jobName)) {
    return notConfigurable(jobName);
  }
  // updateMany (not update) so an unknown job is a 0-row no-op with an inline
  // error rather than a thrown P2025.
  const { count } = await getPrisma().jobConfig.updateMany({
    data: { enabled, runHourUtc, runMinuteUtc },
    where: { jobName },
  });
  if (count === 0) {
    return { error: 'Job not found — refresh and try again.', ok: false };
  }
  // Turning `sweep-retention` off stops transcripts ageing out; turning
  // `judge-sessions` on starts paid model reads of developer transcripts. Both
  // are decisions someone has to be able to attribute afterwards, and this path
  // has a named user where the ingest one only has a shared secret.
  // ADMIN_JOB_TRIGGERED is the existing enum member for admin job control; the
  // justification carries which job changed and how.
  await writeAuditLog({
    action: AuditAction.ADMIN_JOB_TRIGGERED,
    actorUserId: user.id,
    justification: `Job "${jobName}" ${enabled ? 'enabled' : 'disabled'}, scheduled ${pad2(runHourUtc)}:${pad2(runMinuteUtc)} UTC`,
  });
  revalidatePath('/admin/jobs');
  return { message: 'Schedule saved.', ok: true };
});

export const triggerJob = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();
  const jobName = formData.get('jobName') as string;
  if (!jobName) {
    return { error: 'Missing job name.', ok: false };
  }
  if (!CONFIGURABLE_JOBS.has(jobName)) {
    return notConfigurable(jobName);
  }
  // `enabled` is in the predicate, not merely in the UI: a job an admin switched
  // off must not be runnable from here either, or the switch is advisory. The
  // scheduler refuses the same case independently.
  //
  // updateMany (not update) so an unknown job is a 0-row no-op with an inline
  // error rather than a thrown P2025.
  const { count } = await getPrisma().jobConfig.updateMany({
    data: { runRequestedAt: new Date() },
    where: { enabled: true, jobName },
  });
  if (count === 0) {
    return {
      error: 'Job not found or disabled — enable it first, then refresh and try again.',
      ok: false,
    };
  }
  await writeAuditLog({
    action: AuditAction.ADMIN_JOB_TRIGGERED,
    actorUserId: user.id,
    justification: `Manual run requested for job "${jobName}"`,
  });
  revalidatePath('/admin/jobs');
  return { message: 'Run requested — the scheduler picks it up within a minute.', ok: true };
});
