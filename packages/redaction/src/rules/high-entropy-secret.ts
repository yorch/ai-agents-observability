import type { RedactionRule } from './types';

// Catch-all for unknown token formats: long high-entropy base64 (>=32 chars)
// or hex (>=64 chars) strings. Hex minimum is 64 to avoid false-positives on
// 40-char git SHA-1 hashes common in transcripts. Base64 minimum is 32 since
// git hashes don't appear in base64. The entropy gate filters out low-entropy
// repeats: base64 uses 4.5 (close to the max for 64-symbol alphabets), hex uses
// 3.5 (close to the max for 16-symbol alphabets, which is log2(16) = 4.0).
// Runs after structural rules so known tokens get their specific class marker
// instead of this generic one.
const BASE64_RE = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{32,}(?![A-Za-z0-9+/=])/g;
const HEX_RE = /(?<![A-Fa-f0-9])[A-Fa-f0-9]{64,}(?![A-Fa-f0-9])/g;
const BASE64_ENTROPY_THRESHOLD = 4.5;
const HEX_ENTROPY_THRESHOLD = 3.5;

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

export const highEntropySecretRule: RedactionRule = {
  apply(text) {
    let triggered = false;
    let result = text.replace(BASE64_RE, (match) => {
      if (shannonEntropy(match) >= BASE64_ENTROPY_THRESHOLD) {
        triggered = true;
        return '[REDACTED:high-entropy-secret]';
      }
      return match;
    });
    result = result.replace(HEX_RE, (match) => {
      if (shannonEntropy(match) >= HEX_ENTROPY_THRESHOLD) {
        triggered = true;
        return '[REDACTED:high-entropy-secret]';
      }
      return match;
    });
    return { text: result, triggered };
  },
  name: 'high-entropy-secret',
};
