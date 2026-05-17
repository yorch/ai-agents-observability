import { makeRule } from './types.js';

const RE = /AKIA[0-9A-Z]{16}/g;

export const awsAccessKeyRule = makeRule('aws-access-key', RE);
