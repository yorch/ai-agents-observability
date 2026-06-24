import type { AlertPayload } from './payload';

// Email channel seam. A real SMTP transport is intentionally NOT wired here: no
// SMTP dependency is in the pinned catalog yet, and adding one is a separate,
// reviewed change (PLAN §4 pinning policy). Until then this throws a clear,
// logged error that the dispatcher records in alert_delivery_log — the seam
// exists so wiring SMTP later is a drop-in, not a refactor. Subject/body, when
// implemented, must stay aggregate-only like the rest of the payload.
export async function sendEmail(_to: string, _payload: AlertPayload): Promise<void> {
  throw new Error('email channel: SMTP transport not configured (follow-up)');
}
