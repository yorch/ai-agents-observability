import { makeRule } from './types';

// Common API key prefixes: sk- (OpenAI), sk_live_/sk_test_/pk_live_/rk_live_
// (Stripe), and Bearer tokens. Requires at least 20 chars after the prefix to
// avoid flagging short test/example values.
const RE = /(?:sk|pk|rk)[-_](?:live_|test_)?[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9-]{20,}/g;

export const genericApiKeyRule = makeRule('generic-api-key', RE);
