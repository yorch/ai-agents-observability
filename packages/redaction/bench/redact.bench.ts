import { bench, describe } from 'vitest';

import { redact } from '../src/index.js';

function makeLargePlaintext(sizeBytes: number): string {
  const chunk =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
    'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' +
    'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris. ';
  return chunk.repeat(Math.ceil(sizeBytes / chunk.length)).slice(0, sizeBytes);
}

function makeLargeWithSecrets(sizeBytes: number): string {
  const base = makeLargePlaintext(sizeBytes);
  const secrets = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_16C7e42F292c6912E169B7B89B29DCA4BCBA',
    'xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt',
    'MY_SECRET_KEY=hunter2',
  ].join('\n');
  return base.slice(0, sizeBytes / 2) + secrets + base.slice(sizeBytes / 2);
}

const ONE_MB = 1_000_000;

const plainInput = makeLargePlaintext(ONE_MB);
const secretsInput = makeLargeWithSecrets(ONE_MB);

describe('redact() performance', () => {
  bench('1 MB plain text (no secrets)', () => {
    redact(plainInput);
  });

  bench('1 MB text with secrets scattered in', () => {
    redact(secretsInput);
  });
});
