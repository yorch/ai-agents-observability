/**
 * Did the GitHub lookups behind enrichment actually ANSWER?
 *
 * The resolvers (`github-pr.ts`, `github-user.ts`) return null both for "there is
 * no such thing" and for "I could not ask" — gh missing, not logged in, offline, a
 * timeout. Enrichment is stored with the queue row, so it must be able to tell
 * the two apart: an event captured offline must not be stored forever with a null
 * PR just because the lookup that would have filled it in failed together with
 * delivery. Each resolver records a failure here; the flusher resets the counter
 * before enriching a batch and only marks the rows enriched when it is still zero.
 */
let failures = 0;

export function noteLookupFailure(): void {
  failures += 1;
}

export function resetLookupFailures(): void {
  failures = 0;
}

export function lookupFailures(): number {
  return failures;
}
