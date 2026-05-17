import type { RedactionRule } from './types.js';

// GitHub classic PATs and Apps tokens (ghp_, gho_, ghu_, ghs_, ghr_)
// Fine-grained PATs use github_pat_ prefix with longer suffix
const RE = /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}/g;

export const githubTokenRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, () => {
      triggered = true;
      return '[REDACTED:github-token]';
    });
    return { text: result, triggered };
  },
  name: 'github-token',
};
