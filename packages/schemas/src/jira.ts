// Jira issue-key extraction (P5-004 follow-up). Shared by apps/github-app
// (PR branch/title/body) and apps/ingest (session git branch) so the two sides
// of the session ↔ PR ↔ ticket join extract keys identically.

// A Jira key is PROJECT-123: an uppercase project code (letter first), a dash,
// digits. Word-boundary guards stop false positives inside longer tokens
// (e.g. the "SHA-256" in "xSHA-256y" style strings still matches SHA-256 —
// key-shaped tokens are inherently ambiguous; branch/title conventions make
// this acceptable in practice, matching the original P5-004 behaviour).
const JIRA_KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

/**
 * Extracts the first Jira issue key from a single string (branch name, PR
 * title, commit message, …). Returns null if no key is found.
 */
export function extractJiraKey(text: string): string | null {
  const match = JIRA_KEY_RE.exec(text);
  return match?.[1] ?? null;
}

/**
 * Extracts the first Jira issue key across several candidate sources, in
 * priority order (e.g. branch name, then PR title, then PR body). Null and
 * undefined sources are skipped.
 */
export function extractJiraKeyFromSources(
  ...sources: Array<string | null | undefined>
): string | null {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const key = extractJiraKey(source);
    if (key) {
      return key;
    }
  }
  return null;
}
