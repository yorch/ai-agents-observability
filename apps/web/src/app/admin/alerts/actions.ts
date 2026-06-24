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
