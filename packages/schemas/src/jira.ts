// Jira issue-key extraction (P5-004 follow-up). Shared by apps/github-app
// (PR branch/title/body) and apps/ingest (session git branch) so the two sides
// of the session ↔ PR ↔ ticket join extract keys identically.

// A Jira key is PROJECT-123: an uppercase project code (letter first), a dash,
// digits. Now that PR titles and bodies are scanned (not just branch names),
// key-shaped standards tokens are a real false-positive source — "Add UTF-8
// support" must not yield jira_key = "UTF-8". Two guards handle this:
// a not-preceded/followed-by-token-chars boundary, and a denylist of common
// standards prefixes that match the key shape.
// Boundaries: the key must not touch other alphanumerics or a leading dash
// (xOBS-42, PRE-OBS-42, OBS-42x are not keys) but a trailing dash is fine —
// branch names like feature/OBS-42-add-widget are the primary source.
const JIRA_KEY_RE = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]+-\d+)(?![\dA-Za-z])/g;

// Uppercase prefixes that look like Jira project codes but are standards/IDs.
const NON_JIRA_PREFIXES = new Set([
  'AES',
  'CVE',
  'EC',
  'GPT',
  'HTTP',
  'IEEE',
  'ISO',
  'MD',
  'OAUTH',
  'RFC',
  'RSA',
  'SHA',
  'TLS',
  'UTF',
  'UUID',
]);

/**
 * Extracts the first Jira issue key from a single string (branch name, PR
 * title, commit message, …). Returns null if no key is found.
 */
export function extractJiraKey(text: string): string | null {
  JIRA_KEY_RE.lastIndex = 0;
  let match = JIRA_KEY_RE.exec(text);
  while (match) {
    const key = match[1] as string;
    const prefix = key.slice(0, key.indexOf('-'));
    if (!NON_JIRA_PREFIXES.has(prefix)) {
      return key;
    }
    match = JIRA_KEY_RE.exec(text);
  }
  return null;
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
