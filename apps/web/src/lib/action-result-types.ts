/**
 * Client-safe `ActionResult` type. `action-result.ts` carries the server-only
 * `withActionResult` wrapper (which reads the locale via `getLocale()`); this
 * file holds only the type so client components (`ActionForm`, `useActionResult`)
 * can import it without pulling `@/i18n/server` into the client bundle.
 */
export type ActionResult = { ok: true; message?: string } | { error: string; ok: false };
