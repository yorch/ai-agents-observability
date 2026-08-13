/**
 * Result contract for form server actions. Actions must never fail silently:
 * a rejected input returns `{ ok: false, error }` (rendered inline by
 * `ActionForm`), success returns `{ ok: true, message? }`. Guards that
 * previously bailed with a bare `return;` left admins watching a form reset
 * with no explanation.
 */
export type ActionResult = { ok: true; message?: string } | { error: string; ok: false };
