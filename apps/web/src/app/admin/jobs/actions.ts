'use server';

import { revalidatePath } from 'next/cache';

import type { ActionResult } from '@/lib/action-result';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

export async function updateJobConfig(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
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
  // updateMany (not update) so an unknown job is a 0-row no-op with an inline
  // error rather than a thrown P2025.
  const { count } = await getPrisma().jobConfig.updateMany({
    data: { enabled, runHourUtc, runMinuteUtc },
    where: { jobName },
  });
  if (count === 0) {
    return { error: 'Job not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/jobs');
  return { message: 'Schedule saved.', ok: true };
}

export async function triggerJob(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const jobName = formData.get('jobName') as string;
  if (!jobName) {
    return { error: 'Missing job name.', ok: false };
  }
  // updateMany (not update) so an unknown job is a 0-row no-op with an inline
  // error rather than a thrown P2025.
  const { count } = await getPrisma().jobConfig.updateMany({
    data: { runRequestedAt: new Date() },
    where: { jobName },
  });
  if (count === 0) {
    return { error: 'Job not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/jobs');
  return { message: 'Run requested — the scheduler picks it up within a minute.', ok: true };
}
