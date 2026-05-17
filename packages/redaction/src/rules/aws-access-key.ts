import type { RedactionRule } from './types.js';

const RE = /AKIA[0-9A-Z]{16}/g;

export const awsAccessKeyRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, () => {
      triggered = true;
      return '[REDACTED:aws-access-key]';
    });
    return { text: result, triggered };
  },
  name: 'aws-access-key',
};
