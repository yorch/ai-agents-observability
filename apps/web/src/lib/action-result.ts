/**
 * Result contract for form server actions. Actions must never fail silently:
 * a rejected input returns `{ ok: false, error }` (rendered inline by
 * `ActionForm`), success returns `{ ok: true, message? }`. Guards that
 * previously bailed with a bare `return;` left admins watching a form reset
 * with no explanation.
 */
export type ActionResult = { ok: true; message?: string } | { error: string; ok: false };

/**
 * Wraps a form server action so an unexpected throw becomes an inline
 * `{ ok: false, error }` instead of escaping useActionState and replacing the
 * page with the error boundary. `redirect()` must keep working — Next signals
 * it by throwing, so rethrow anything with a `digest` string (covers both
 * NEXT_REDIRECT and notFound).
 */
export function withActionResult(
  fn: (formData: FormData) => Promise<ActionResult>,
): (formData: FormData) => Promise<ActionResult> {
  return async (formData) => {
    try {
      return await fn(formData);
    } catch (err) {
      if (typeof (err as { digest?: unknown })?.digest === 'string') {
        throw err;
      }
      console.error(err);
      return { error: 'Something went wrong — try again.', ok: false };
    }
  };
}
