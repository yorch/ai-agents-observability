import { awsAccessKeyRule } from './rules/aws-access-key.js';
import { awsSecretKeyRule } from './rules/aws-secret-key.js';
import { envSecretRule } from './rules/env-secret.js';
import { githubTokenRule } from './rules/github-token.js';
import { jwtRule } from './rules/jwt.js';
import { privateKeyRule } from './rules/private-key.js';
import { slackTokenRule } from './rules/slack-token.js';
import type { RedactionRule } from './rules/types.js';

export type { RedactionRule };

const RULES: RedactionRule[] = [
  awsAccessKeyRule,
  awsSecretKeyRule,
  githubTokenRule,
  jwtRule,
  slackTokenRule,
  envSecretRule,
  privateKeyRule,
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
