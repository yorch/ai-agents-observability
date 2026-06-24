import type { PrismaClient } from '@ai-agents-observability/db';
import type { AlertSeverity } from '@ai-agents-observability/schemas';

// A rule either fires (with a severity + AGGREGATE-ONLY details) or it doesn't.
// `details` must never carry individual session ids, user names, or transcript
// content — it feeds the notification step (P9-002), which is org-aggregate only.
export type AlertEvaluation = {
  details: Record<string, unknown>;
  severity: AlertSeverity;
} | null;

/**
 * Idempotent firing/resolving transition for one rule. Records each transition
 * exactly once: a still-firing condition does not insert a second open event, and
 * a cleared condition resolves the existing open event. Kept free of any runtime
 * Prisma import so it is unit-testable without the generated client.
 */
export async function applyAlertTransition(
  db: Pick<PrismaClient, 'alertEvent'>,
  ruleId: string,
  evaluation: AlertEvaluation,
): Promise<'fired' | 'resolved' | 'noop'> {
  const open = await db.alertEvent.findFirst({ where: { resolvedAt: null, ruleId } });

  if (evaluation && !open) {
    await db.alertEvent.create({
      data: { details: evaluation.details, ruleId, severity: evaluation.severity },
    });
    return 'fired';
  }
  if (!evaluation && open) {
    await db.alertEvent.update({ data: { resolvedAt: new Date() }, where: { id: open.id } });
    return 'resolved';
  }
  return 'noop';
}
