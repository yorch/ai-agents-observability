import { makeRule } from './types';

// Email addresses (PII). A required dotted TLD keeps the false-positive rate
// low; over-redaction is the safe direction for PII, so an occasional
// "asset@2x.png"-style match is acceptable. The whole address is replaced.
const RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export const emailRule = makeRule('email', RE);
