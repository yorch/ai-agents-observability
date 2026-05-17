import type { RedactionRule } from './types.js';

// Matches PEM private key blocks (RSA, EC, OPENSSH, PGP, bare PRIVATE KEY)
const RE =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;

export const privateKeyRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, () => {
      triggered = true;
      return '[REDACTED:private-key]';
    });
    return { text: result, triggered };
  },
  name: 'private-key',
};
