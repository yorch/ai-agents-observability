import 'server-only';

import { getDictionary, getLocale } from '@/i18n/server';

export type { ActionResult } from './action-result-types';

/**
 * Wraps a form server action so an unexpected throw becomes an inline
 * `{ ok: false, error }` instead of escaping useActionState and replacing the
 * page with the error boundary. `redirect()` must keep working — Next signals
 * it by throwing, so rethrow anything with a `digest` string (covers both
 * NEXT_REDIRECT and notFound).
 *
 * The fallback error message is localized via the request-scoped locale.
 */
export function withActionResult(
  fn: (formData: FormData) => Promise<import('./action-result-types').ActionResult>,
): (formData: FormData) => Promise<import('./action-result-types').ActionResult> {
  return async (formData) => {
    try {
      return await fn(formData);
    } catch (err) {
      if (typeof (err as { digest?: unknown })?.digest === 'string') {
        throw err;
      }
      console.error(err);
      const locale = await getLocale();
      const dict = getDictionary(locale);
      return { error: dict.actionResult.unexpectedError, ok: false };
    }
  };
}
