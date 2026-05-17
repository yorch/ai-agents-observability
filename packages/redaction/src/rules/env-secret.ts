import type { RedactionRule } from './types.js';

// Matches KEY=value where the key ends in _KEY, _TOKEN, _SECRET, or _PASSWORD.
// Preserves the key name; redacts only the value so context is retained.
const RE = /([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)=)\S+/gi;

export const envSecretRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, (_match, keyPart: string) => {
      triggered = true;
      return `${keyPart}[REDACTED:env-secret]`;
    });
    return { text: result, triggered };
  },
  name: 'env-secret',
};
