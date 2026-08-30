import type { RedactionRule } from './types';

// Database/service connection strings with embedded credentials in the
// userinfo. Only the user:pass portion is redacted; scheme and host are
// preserved so the destination stays identifiable. Handles both
// `scheme://user:pass@host` and `scheme://:pass@host` (Redis no-username).
// Runs after the structural token rules so a known token in the password
// position is redacted with its own class first.
const RE = /\b(postgres(?:ql)?|mongodb(?:\+srv)?|redis|mysql):\/\/[^/\s@[\]]*:[^/\s@[\]]+@/gi;

export const connectionStringRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, (_match, scheme: string) => {
      triggered = true;
      return `${scheme}://[REDACTED:connection-string]@`;
    });
    return { text: result, triggered };
  },
  name: 'connection-string',
};
