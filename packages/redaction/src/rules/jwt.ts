import type { RedactionRule } from './types.js';

// JWT: header starts with eyJ (base64url of {"...), payload similarly, then signature
const RE = /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g;

export const jwtRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, () => {
      triggered = true;
      return '[REDACTED:jwt]';
    });
    return { text: result, triggered };
  },
  name: 'jwt',
};
