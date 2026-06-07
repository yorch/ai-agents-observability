'use server';

import { revalidatePath } from 'next/cache';

import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

export async function updateJobConfig(formData: FormData) {
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
    return;
  }
  await getPrisma().jobConfig.update({
    data: { enabled, runHourUtc, runMinuteUtc },
    where: { jobName },
  });
  revalidatePath('/admin/jobs');
}

export async function triggerJob(formData: FormData) {
  await requireOrgAdmin();
  const jobName = formData.get('jobName') as string;
  if (!jobName) {
    return;
  }
  await getPrisma().jobConfig.update({
    data: { runRequestedAt: new Date() },
    where: { jobName },
  });
  revalidatePath('/admin/jobs');
}
