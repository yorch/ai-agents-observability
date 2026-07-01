'use server';

import { BudgetThresholdParamsSchema } from '@ai-agents-observability/schemas';
import { revalidatePath } from 'next/cache';

import { AuditAction, writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const CHANNEL_TYPES = new Set(['webhook', 'slack_webhook', 'email']);

// Allowed silence windows (hours). Bounds the dropdown and rejects arbitrary input.
const SILENCE_HOURS = new Set([1, 4, 24, 72]);

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
  if (!id) {
    return;
  }
  // Validate + coerce through the shared schema so the write matches exactly what
  // the evaluator reads. A missing/non-positive budget fails the parse → no-op.
  const parsed = BudgetThresholdParamsSchema.safeParse({
    budgetUsd: formData.get('budgetUsd'),
    windowDays: formData.get('windowDays'),
  });
  if (!parsed.success) {
    return;
  }
  await getPrisma().alertRule.updateMany({ data: { params: parsed.data }, where: { id } });
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

/** R7: acknowledge an open alert firing ("seen it"). Audited; not the same as resolve. */
export async function acknowledgeAlert(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return;
  }
  await getPrisma().alertEvent.updateMany({
    data: { acknowledgedAt: new Date(), acknowledgedByUserId: user.id },
    where: { acknowledgedAt: null, id: BigInt(id) },
  });
  void writeAuditLog({ action: AuditAction.ALERT_ACKNOWLEDGED, actorUserId: user.id });
  revalidatePath('/admin/alerts');
}

/** R7: silence a rule for a bounded window — it is evaluated but neither fires nor notifies. */
export async function silenceRule(formData: FormData): Promise<void> {
  const { user } = await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const hours = Number(formData.get('hours') ?? 0);
  if (!id || !SILENCE_HOURS.has(hours)) {
    return;
  }
  const silencedUntil = new Date(Date.now() + hours * 3_600_000);
  await getPrisma().alertRule.updateMany({ data: { silencedUntil }, where: { id } });
  void writeAuditLog({
    action: AuditAction.ALERT_SILENCED,
    actorUserId: user.id,
    justification: `silenced ${hours}h`,
  });
  revalidatePath('/admin/alerts');
}

/** R7: lift a silence early. */
export async function unsilenceRule(formData: FormData): Promise<void> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return;
  }
  await getPrisma().alertRule.updateMany({ data: { silencedUntil: null }, where: { id } });
  revalidatePath('/admin/alerts');
}
