import { makeRule } from './types.js';

// Matches PEM private key blocks (RSA, EC, OPENSSH, bare PRIVATE KEY, PGP PRIVATE KEY BLOCK)
const RE =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY(?: BLOCK)?-----/g;

export const privateKeyRule = makeRule('private-key', RE);
