import { makeRule } from './types.js';

// JWT: header starts with eyJ (base64url of {"...), payload similarly, then signature
const RE = /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g;

export const jwtRule = makeRule('jwt', RE);
