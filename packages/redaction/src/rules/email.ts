import { makeRule } from './types';

// Email addresses (PII). A required dotted TLD keeps the false-positive rate
// low; over-redaction is the safe direction for PII, so an occasional
// "asset@2x.png"-style match is acceptable. The whole address is replaced.
// Quantifiers are bounded to RFC 5321 limits (local ≤64, domain ≤255, label
// ≤63) — that covers every real address while keeping the match linear-time on
// pathological input, matching the rest of the redaction pipeline.
const RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,63}\b/g;

export const emailRule = makeRule('email', RE);
