import { makeRule } from './types';

// xoxa- (legacy), xoxb- (bot), xoxp- (user) — require at least 10 chars after prefix
const RE = /xox[abp]-[0-9A-Za-z-]{10,}/g;

export const slackTokenRule = makeRule('slack-token', RE);
