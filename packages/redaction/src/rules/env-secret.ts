import type { RedactionRule } from './types';

// Matches KEY=value where the key ends in _KEY, _TOKEN, _SECRET, or _PASSWORD.
// Handles bare, double-quoted, and single-quoted values; preserves the key name.
// The key prefix is length-bounded ({0,128}) so a long alphanumeric run with no
// `_KEY`/`_TOKEN`/… suffix (base64 blobs, minified code, hashes — common in
// transcripts) can't force O(n²) backtracking; no real env var name is longer.
const RE = /([A-Z][A-Z0-9_]{0,128}(?:_KEY|_TOKEN|_SECRET|_PASSWORD)=)(?:"[^"]*"|'[^']*'|\S+)/gi;

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
