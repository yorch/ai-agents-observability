import type { RedactionRule } from './types.js';

// xoxa- (legacy), xoxb- (bot), xoxp- (user) — require at least 10 chars after prefix
const RE = /xox[abp]-[0-9A-Za-z-]{10,}/g;

export const slackTokenRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, () => {
      triggered = true;
      return '[REDACTED:slack-token]';
    });
    return { text: result, triggered };
  },
  name: 'slack-token',
};
