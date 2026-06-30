'use server';

import { revalidatePath } from 'next/cache';

import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const CHANNEL_TYPES = new Set(['webhook', 'slack_webhook', 'email']);

export async function toggleRule(formData: FormData): Promise<void> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!id) {
    return;
  }
  await getPrisma().alertRule.updateMany({ data: { enabled }, where: { id } });
  revalidatePath('/admin/alerts');
}

/**
 * Set the spend budget (params.budgetUsd, optional params.windowDays) for a
 * budget_threshold rule. The evaluator is inert until a positive budget is set, so
 * this is what turns the seeded rule on. Invalid input is ignored (no-op) rather
 * than persisted, matching the other actions' defensive style.
 */
export async function updateBudgetThreshold(formData: FormData): Promise<void> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const budgetUsd = Number(formData.get('budgetUsd'));
  if (!id || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    return;
  }
  const params: Record<string, number> = { budgetUsd };
  const windowDays = Number(formData.get('windowDays'));
  if (Number.isFinite(windowDays) && windowDays > 0) {
    params.windowDays = Math.floor(windowDays);
  }
  await getPrisma().alertRule.updateMany({ data: { params }, where: { id } });
  revalidatePath('/admin/alerts');
}

/** Add a notification channel. Config is a small typed object per channel type. */
export async function addChannel(formData: FormData): Promise<void> {
  await requireOrgAdmin();
  const channelType = String(formData.get('channelType') ?? '');
  const target = String(formData.get('target') ?? '').trim();
  if (!CHANNEL_TYPES.has(channelType) || !target) {
    return;
  }
  const config =
    channelType === 'webhook'
      ? { url: target }
      : channelType === 'slack_webhook'
        ? { webhookUrl: target }
        : { to: target };

  await getPrisma().alertChannelConfig.create({ data: { channelType, config, enabled: true } });
  revalidatePath('/admin/alerts');
}

export async function toggleChannel(formData: FormData): Promise<void> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!id) {
    return;
  }
  await getPrisma().alertChannelConfig.updateMany({ data: { enabled }, where: { id } });
  revalidatePath('/admin/alerts');
}

export async function deleteChannel(formData: FormData): Promise<void> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return;
  }
  await getPrisma().alertChannelConfig.deleteMany({ where: { id } });
  revalidatePath('/admin/alerts');
}
