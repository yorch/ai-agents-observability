'use server';

import { BudgetThresholdParamsSchema } from '@ai-agents-observability/schemas';
import { revalidatePath } from 'next/cache';

import type { ActionResult } from '@/lib/action-result';
import { AuditAction, writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

const CHANNEL_TYPES = new Set(['webhook', 'slack_webhook', 'email']);

// Allowed silence windows (hours). Bounds the dropdown and rejects arbitrary input.
const SILENCE_HOURS = new Set([1, 4, 24, 72]);

export async function toggleRule(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!id) {
    return { error: 'Missing rule id — refresh and try again.', ok: false };
  }
  const { count } = await getPrisma().alertRule.updateMany({ data: { enabled }, where: { id } });
  if (count === 0) {
    return { error: 'Rule not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/alerts');
  return { message: 'Rule updated.', ok: true };
}

/**
 * Set the spend budget (params.budgetUsd, optional params.windowDays) for a
 * budget_threshold rule. The evaluator is inert until a positive budget is set, so
 * this is what turns the seeded rule on. Invalid input is rejected with an inline
 * error rather than persisted.
 */
export async function updateBudgetThreshold(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: 'Missing rule id — refresh and try again.', ok: false };
  }
  // Validate + coerce through the shared schema so the write matches exactly what
  // the evaluator reads. A missing/non-positive budget fails the parse.
  const parsed = BudgetThresholdParamsSchema.safeParse({
    budgetUsd: formData.get('budgetUsd'),
    windowDays: formData.get('windowDays'),
  });
  if (!parsed.success) {
    return {
      error: 'Budget must be a positive amount and window a whole number of days.',
      ok: false,
    };
  }
  const { count } = await getPrisma().alertRule.updateMany({
    data: { params: parsed.data },
    where: { id },
  });
  if (count === 0) {
    return { error: 'Rule not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/alerts');
  return { message: 'Threshold saved.', ok: true };
}

/** Add a notification channel. Config is a small typed object per channel type. */
export async function addChannel(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const channelType = String(formData.get('channelType') ?? '');
  const target = String(formData.get('target') ?? '').trim();
  if (!CHANNEL_TYPES.has(channelType)) {
    return { error: 'Choose a valid channel type.', ok: false };
  }
  if (!target) {
    return { error: 'Enter a target URL or email address.', ok: false };
  }
  const config =
    channelType === 'webhook'
      ? { url: target }
      : channelType === 'slack_webhook'
        ? { webhookUrl: target }
        : { to: target };

  await getPrisma().alertChannelConfig.create({ data: { channelType, config, enabled: true } });
  revalidatePath('/admin/alerts');
  return { message: 'Channel added.', ok: true };
}

export async function toggleChannel(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!id) {
    return { error: 'Missing channel id — refresh and try again.', ok: false };
  }
  const { count } = await getPrisma().alertChannelConfig.updateMany({
    data: { enabled },
    where: { id },
  });
  if (count === 0) {
    return { error: 'Channel not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/alerts');
  return { message: 'Channel updated.', ok: true };
}

export async function deleteChannel(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: 'Missing channel id — refresh and try again.', ok: false };
  }
  const { count } = await getPrisma().alertChannelConfig.deleteMany({ where: { id } });
  if (count === 0) {
    return { error: 'Channel not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/alerts');
  return { message: 'Channel removed.', ok: true };
}

/** R7: acknowledge an open alert firing ("seen it"). Audited; not the same as resolve. */
export async function acknowledgeAlert(formData: FormData): Promise<ActionResult> {
  const { user } = await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: 'Missing alert id — refresh and try again.', ok: false };
  }
  const { count } = await getPrisma().alertEvent.updateMany({
    data: { acknowledgedAt: new Date(), acknowledgedByUserId: user.id },
    where: { acknowledgedAt: null, id: BigInt(id) },
  });
  if (count === 0) {
    return { error: 'Alert already acknowledged or not found — refresh and try again.', ok: false };
  }
  void writeAuditLog({ action: AuditAction.ALERT_ACKNOWLEDGED, actorUserId: user.id });
  revalidatePath('/admin/alerts');
  return { message: 'Acknowledged.', ok: true };
}

/** R7: silence a rule for a bounded window — it is evaluated but neither fires nor notifies. */
export async function silenceRule(formData: FormData): Promise<ActionResult> {
  const { user } = await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  const hours = Number(formData.get('hours') ?? 0);
  if (!id) {
    return { error: 'Missing rule id — refresh and try again.', ok: false };
  }
  if (!SILENCE_HOURS.has(hours)) {
    return { error: 'Choose a silence window from the list.', ok: false };
  }
  const silencedUntil = new Date(Date.now() + hours * 3_600_000);
  const { count } = await getPrisma().alertRule.updateMany({
    data: { silencedUntil },
    where: { id },
  });
  if (count === 0) {
    return { error: 'Rule not found — refresh and try again.', ok: false };
  }
  void writeAuditLog({
    action: AuditAction.ALERT_SILENCED,
    actorUserId: user.id,
    justification: `silenced ${hours}h`,
  });
  revalidatePath('/admin/alerts');
  return { message: 'Rule silenced.', ok: true };
}

/** R7: lift a silence early. */
export async function unsilenceRule(formData: FormData): Promise<ActionResult> {
  await requireOrgAdmin();
  const id = String(formData.get('id') ?? '');
  if (!id) {
    return { error: 'Missing rule id — refresh and try again.', ok: false };
  }
  const { count } = await getPrisma().alertRule.updateMany({
    data: { silencedUntil: null },
    where: { id },
  });
  if (count === 0) {
    return { error: 'Rule not found — refresh and try again.', ok: false };
  }
  revalidatePath('/admin/alerts');
  return { message: 'Silence cleared.', ok: true };
}
