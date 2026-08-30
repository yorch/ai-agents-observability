import { awsAccessKeyRule } from './rules/aws-access-key';
import { awsSecretKeyRule } from './rules/aws-secret-key';
import { connectionStringRule } from './rules/connection-string';
import { emailRule } from './rules/email';
import { envSecretRule } from './rules/env-secret';
import { genericApiKeyRule } from './rules/generic-api-key';
import { gitRemoteUrlRule } from './rules/git-remote-url';
import { githubTokenRule } from './rules/github-token';
import { highEntropySecretRule } from './rules/high-entropy-secret';
import { jwtRule } from './rules/jwt';
import { privateKeyRule } from './rules/private-key';
import { slackTokenRule } from './rules/slack-token';
import type { RedactionRule } from './rules/types';

export type { RedactionRule };

// Order matters: the structural secret rules run first so a known token inside a
// URL's userinfo is redacted with its own class before git-remote-url sees it
// (git-remote-url then skips the resulting `[REDACTED:…]` marker rather than
// clobbering it). generic-api-key, connection-string, and high-entropy-secret
// run after the structural rules so known tokens get their specific class
// marker. email runs last — a bare address never overlaps the others.
const RULES: RedactionRule[] = [
  awsAccessKeyRule,
  awsSecretKeyRule,
  githubTokenRule,
  jwtRule,
  slackTokenRule,
  envSecretRule,
  privateKeyRule,
  genericApiKeyRule,
  connectionStringRule,
  highEntropySecretRule,
  gitRemoteUrlRule,
  emailRule,
];

export type RedactionResult = {
  flags: string[];
  text: string;
};

export function redact(text: string): RedactionResult {
  let current = text;
  const flags: string[] = [];

  for (const rule of RULES) {
    const { text: next, triggered } = rule.apply(current);
    current = next;
    if (triggered) {
      flags.push(rule.name);
    }
  }

  return { flags, text: current };
}

// Inverse of the `[REDACTED:<name>]` marker that makeRule writes (see
// rules/types.ts): given already-redacted text, recover the distinct set of
// redaction classes whose markers it contains, sorted. Lives beside redact()
// so consumers that scan stored redacted text — e.g. the ingest redaction-flag
// backfill — share one definition of the marker contract instead of
// re-hardcoding the pattern. The round-trip (redact → scanRedactionMarkers) is
// asserted in the package tests so the two can't silently drift.
const REDACTION_MARKER_RE = /\[REDACTED:([a-z0-9-]+)\]/g;

export function scanRedactionMarkers(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(REDACTION_MARKER_RE)) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}
