import type { RedactionRule } from './types.js';

// Matches 40-char base64 strings that are not part of a longer base64 sequence.
// The entropy check reduces false positives — real AWS secrets are highly random.
const RE = /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g;
const ENTROPY_THRESHOLD = 4.5;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export const awsSecretKeyRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    const result = text.replace(RE, (match) => {
      if (shannonEntropy(match) >= ENTROPY_THRESHOLD) {
        triggered = true;
        return '[REDACTED:aws-secret-key]';
      }
      return match;
    });
    return { text: result, triggered };
  },
  name: 'aws-secret-key',
};
