'use server';

import type { AgentType } from '@ai-agents-observability/db';
import { AuditAction } from '@ai-agents-observability/db';
import {
  ADAPTER_AGENT_TYPES,
  agentDisplayName,
  DEFAULT_CHEAP_CATEGORIES,
  MODEL_TIERS,
  type ModelTier,
  parseTierOverrides,
} from '@ai-agents-observability/schemas';
import { revalidatePath } from 'next/cache';
import { withActionResult } from '@/lib/action-result';
import { writeAuditLog } from '@/lib/audit';
import { getPrisma } from '@/lib/prisma';
import { requireOrgAdmin } from '@/lib/roles';

// Org-admin writes for /admin/model-policy (P10-002). Unlike the retention
// editor, there is no row to update: a policy row only exists once an admin has
// saved something for that agent, so every write is an `upsert` keyed on
// agentType and the "not found — refresh and try again" case cannot arise.

const PATH = '/admin/model-policy';

// Writable agents are the ones the page renders. Accepting the wider
// AGENT_TYPES would let a crafted POST create a policy row for an agent with no
// adapter — a row the ingest evaluator honours but no page can show or clear.
function parseAgentType(raw: FormDataEntryValue | null): AgentType | null {
  const value = String(raw ?? '');
  // The registry and the Prisma enum hold the same values — asserted by
  // agent-registry.test.ts — so membership here is a safe narrowing.
  return (ADAPTER_AGENT_TYPES as readonly string[]).includes(value) ? (value as AgentType) : null;
}

function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

// Caps on admin free text. Nothing here is a privilege boundary — the actions
// are org-admin only — but `allowed_models` is scanned per event by the ingest
// alert sweep, and the allow-list is echoed into an audit justification, so an
// unbounded paste would bloat both. A model id far longer than this is a typo.
const MAX_ENTRY_LENGTH = 128;
const MAX_ENTRIES = 100;
// Leaves room for the surrounding prose inside MAX_JUSTIFICATION_LENGTH (1000).
const AUDIT_LIST_CHARS = 700;

/**
 * Render a list into an audit justification without blowing the column's
 * documented 1000-char bound — 100 entries of 128 chars would otherwise far
 * exceed it. The count is always exact; only the enumeration is elided.
 */
function summarizeList(entries: string[]): string {
  const joined = entries.join(', ');
  return joined.length <= AUDIT_LIST_CHARS ? joined : `${joined.slice(0, AUDIT_LIST_CHARS)}…`;
}

/** Comma-separated free text → trimmed, de-duplicated, capped entries. */
function parseList(raw: FormDataEntryValue | null): string[] {
  return [
    ...new Set(
      String(raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= MAX_ENTRY_LENGTH),
    ),
  ].slice(0, MAX_ENTRIES);
}

/**
 * Set or clear one model's tier override. An empty `tier` clears it, dropping
 * that model back to the price-derived tier.
 *
 * The stored `tierOverrides` JSON is **merged**, never replaced: the column
 * holds every model the admin has classified for this agent, and a row-level
 * form only ever knows about its own model.
 */
export const setModelTierOverride = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();

  const agentType = parseAgentType(formData.get('agentType'));
  if (!agentType) {
    return { error: `Unknown agent "${String(formData.get('agentType') ?? '')}".`, ok: false };
  }

  const model = String(formData.get('model') ?? '').trim();
  if (!model) {
    return { error: 'Missing model.', ok: false };
  }
  if (model.length > MAX_ENTRY_LENGTH) {
    return { error: `Model id is too long (max ${MAX_ENTRY_LENGTH} characters).`, ok: false };
  }

  const rawTier = String(formData.get('tier') ?? '').trim();
  if (rawTier !== '' && !isModelTier(rawTier)) {
    return {
      error: `"${rawTier}" is not a model tier — expected one of ${MODEL_TIERS.join(', ')}.`,
      ok: false,
    };
  }

  const db = getPrisma();
  const existing = await db.modelPolicy.findUnique({
    select: { tierOverrides: true },
    where: { agentType },
  });
  const overrides = parseTierOverrides(existing?.tierOverrides);
  if (rawTier === '') {
    delete overrides[model];
  } else {
    overrides[model] = rawTier;
  }

  await db.modelPolicy.upsert({
    create: {
      agentType,
      allowedModels: [],
      cheapCategories: [],
      tierOverrides: overrides,
      updatedByUserId: user.id,
    },
    update: { tierOverrides: overrides, updatedByUserId: user.id },
    where: { agentType },
  });

  const label = agentDisplayName(agentType);
  await writeAuditLog({
    action: AuditAction.MODEL_POLICY_CHANGED,
    actorUserId: user.id,
    justification:
      rawTier === ''
        ? `Cleared tier override for ${label} model "${model}" (revert to price-derived tier)`
        : `Set ${label} model "${model}" to the ${rawTier} tier`,
  });

  revalidatePath(PATH);
  return {
    message: rawTier === '' ? `Override cleared for ${model}.` : `${model} set to ${rawTier} tier.`,
    ok: true,
  };
});

/**
 * Replace one agent's allow-list. An empty list means *no allow-list* — every
 * model is allowed — and never "deny everything"; see `isModelAllowed`.
 */
export const setAllowedModels = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();

  const agentType = parseAgentType(formData.get('agentType'));
  if (!agentType) {
    return { error: `Unknown agent "${String(formData.get('agentType') ?? '')}".`, ok: false };
  }

  const allowedModels = parseList(formData.get('models'));

  await getPrisma().modelPolicy.upsert({
    create: { agentType, allowedModels, cheapCategories: [], updatedByUserId: user.id },
    update: { allowedModels, updatedByUserId: user.id },
    where: { agentType },
  });

  const label = agentDisplayName(agentType);
  await writeAuditLog({
    action: AuditAction.MODEL_POLICY_CHANGED,
    actorUserId: user.id,
    justification:
      allowedModels.length === 0
        ? `Cleared the ${label} allow-list (every model allowed)`
        : `Set the ${label} allow-list to ${allowedModels.length} model(s): ${summarizeList(allowedModels)}`,
  });

  revalidatePath(PATH);
  return {
    message:
      allowedModels.length === 0
        ? 'Allow-list cleared — every model is allowed.'
        : `Allow-list set to ${allowedModels.length} model(s).`,
    ok: true,
  };
});

/**
 * Replace one agent's cheap-work tool categories. An empty list falls back to
 * `DEFAULT_CHEAP_CATEGORIES` at resolve time rather than meaning "nothing is
 * cheap", so clearing the field restores the default rather than disabling
 * routing recommendations.
 */
export const setCheapCategories = withActionResult(async (formData) => {
  const { user } = await requireOrgAdmin();

  const agentType = parseAgentType(formData.get('agentType'));
  if (!agentType) {
    return { error: `Unknown agent "${String(formData.get('agentType') ?? '')}".`, ok: false };
  }

  const cheapCategories = parseList(formData.get('categories'));

  await getPrisma().modelPolicy.upsert({
    create: { agentType, allowedModels: [], cheapCategories, updatedByUserId: user.id },
    update: { cheapCategories, updatedByUserId: user.id },
    where: { agentType },
  });

  const label = agentDisplayName(agentType);
  const fallback = DEFAULT_CHEAP_CATEGORIES.join(', ');
  await writeAuditLog({
    action: AuditAction.MODEL_POLICY_CHANGED,
    actorUserId: user.id,
    justification:
      cheapCategories.length === 0
        ? `Cleared the ${label} cheap-work categories (fall back to ${fallback})`
        : `Set the ${label} cheap-work categories to ${summarizeList(cheapCategories)}`,
  });

  revalidatePath(PATH);
  return {
    message:
      cheapCategories.length === 0
        ? `Cheap categories cleared — falling back to ${fallback}.`
        : `Cheap categories set to ${cheapCategories.join(', ')}.`,
    ok: true,
  };
});
