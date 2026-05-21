import { awsAccessKeyRule } from './rules/aws-access-key';
import { awsSecretKeyRule } from './rules/aws-secret-key';
import { envSecretRule } from './rules/env-secret';
import { githubTokenRule } from './rules/github-token';
import { jwtRule } from './rules/jwt';
import { privateKeyRule } from './rules/private-key';
import { slackTokenRule } from './rules/slack-token';
import type { RedactionRule } from './rules/types';

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
