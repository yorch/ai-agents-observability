'use server';

import { revalidatePath } from 'next/cache';

import { withActionResult } from '@/lib/action-result';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { CONFIGURABLE_JOBS } from '@/lib/configurable-jobs';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const pad2 = (n: number) => String(n).padStart(2, '0');

const notConfigurable = (jobName: string) => ({
  error: `"${jobName}" has no editable schedule — it runs on a fixed timer or by operator trigger only.`,
  ok: false as const,
});

export const updateJobConfig = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();
  // String(...) rather than `as string`: FormData.get returns
  // FormDataEntryValue | null, so the cast was a claim the runtime does not
  // honour — a File or null would reach the allowlist check and be interpolated
  // into an error message as "[object File]".
  const jobName = String(formData.get('jobName') ?? '').trim();
  const enabled = formData.get('enabled') === 'on';
  const runHourUtc = Number(formData.get('runHourUtc'));
  const runMinuteUtc = Number(formData.get('runMinuteUtc'));
  // Reported separately. Folding a missing job name into the hour/minute branch
  // answered "which job?" with "Hour must be 0-23" — a rejection that does not
  // name what was wrong, which is the convention this file is meant to keep.
  if (!jobName) {
    return { error: 'Missing job name.', ok: false };
  }
  if (
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
  const jobName = String(formData.get('jobName') ?? '').trim();
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
