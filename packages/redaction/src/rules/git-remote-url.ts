import type { RedactionRule } from './types';

// Credentials embedded in a URL's userinfo — `scheme://user:secret@host` or
// `scheme://secret@host`. Git remotes with a baked-in credential are the common
// source (`https://user:password@gitlab.com/…`, or a token type the standalone
// token rules don't recognise). This rule runs AFTER the token rules, so a known
// token in the password position is redacted with its own class first; the
// `[` / `]` exclusions below then stop this rule from re-matching (and
// clobbering) that `[REDACTED:…]` marker. Only the userinfo is redacted —
// scheme, host, and path are preserved so the remote stays identifiable.
const RE = /\b(https?:\/\/)[^/\s:@[\]]+(?::[^/\s@[\]]+)?@/gi;

export const gitRemoteUrlRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, (_match, scheme: string) => {
      triggered = true;
      return `${scheme}[REDACTED:git-remote-url]@`;
    });
    return { text: result, triggered };
  },
  name: 'git-remote-url',
};
