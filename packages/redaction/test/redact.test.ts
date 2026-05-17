import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { redact } from '../src/index.js';

function loadCassette(name: string): string {
  return readFileSync(join(import.meta.dirname, 'cassettes', name), 'utf-8').trim();
}

// ── AWS access key ────────────────────────────────────────────────────────────

describe('aws-access-key', () => {
  it('redacts all positive cassette examples', () => {
    const lines = loadCassette('aws-access-key.txt').split('\n');
    for (const line of lines) {
      const { text, flags } = redact(line);
      expect(flags).toContain('aws-access-key');
      expect(text).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  it('does not flag a non-AKIA string', () => {
    const { flags } = redact('ABIA1234567890ABCDEF is not a key');
    expect(flags).not.toContain('aws-access-key');
  });

  it('leaves clean text unchanged', () => {
    const clean = 'Hello world, no secrets here.';
    expect(redact(clean).text).toBe(clean);
  });
});

// ── GitHub token ──────────────────────────────────────────────────────────────

describe('github-token', () => {
  it('redacts all positive cassette examples', () => {
    const lines = loadCassette('github-token.txt').split('\n');
    for (const line of lines) {
      const { flags } = redact(line);
      expect(flags).toContain('github-token');
    }
  });

  it('does not flag a short ghp_ string', () => {
    const { flags } = redact('ghp_short');
    expect(flags).not.toContain('github-token');
  });

  it('does not flag a non-token ghp_ look-alike', () => {
    const { flags } = redact('ghp_ is not a token prefix without alphanum');
    expect(flags).not.toContain('github-token');
  });
});

// ── JWT ───────────────────────────────────────────────────────────────────────

describe('jwt', () => {
  it('redacts all positive cassette examples', () => {
    const lines = loadCassette('jwt.txt').split('\n');
    for (const line of lines) {
      const { flags } = redact(line);
      expect(flags).toContain('jwt');
    }
  });

  it('does not flag plain base64 without the eyJ prefix pattern', () => {
    const { flags } = redact('abc.def.ghi is not a JWT');
    expect(flags).not.toContain('jwt');
  });
});

// ── Slack token ───────────────────────────────────────────────────────────────

describe('slack-token', () => {
  it('redacts all positive cassette examples', () => {
    const lines = loadCassette('slack-token.txt').split('\n');
    for (const line of lines) {
      const { flags } = redact(line);
      expect(flags).toContain('slack-token');
    }
  });

  it('does not flag xoxc- (non-matching prefix)', () => {
    const { flags } = redact('xoxc-123456789012-1234567890');
    expect(flags).not.toContain('slack-token');
  });

  it('does not flag a very short xoxb- string', () => {
    const { flags } = redact('xoxb-123');
    expect(flags).not.toContain('slack-token');
  });
});

// ── Env secret ────────────────────────────────────────────────────────────────

describe('env-secret', () => {
  it('redacts all positive cassette examples', () => {
    const lines = loadCassette('env-secret.txt').split('\n');
    for (const line of lines) {
      const { flags } = redact(line);
      expect(flags).toContain('env-secret');
    }
  });

  it('preserves the key name, only redacts value', () => {
    const { text } = redact('MY_SECRET_KEY=hunter2');
    expect(text).toContain('MY_SECRET_KEY=');
    expect(text).not.toContain('hunter2');
  });

  it('does not flag an unrelated assignment', () => {
    const { flags } = redact('PORT=3000');
    expect(flags).not.toContain('env-secret');
  });
});

// ── Private key ───────────────────────────────────────────────────────────────

describe('private-key', () => {
  it('redacts all positive cassette examples', () => {
    const cassette = loadCassette('private-key.txt');
    const { flags } = redact(cassette);
    expect(flags).toContain('private-key');
    expect(flags.filter((f) => f === 'private-key')).toHaveLength(1);
  });

  it('does not flag a public key header', () => {
    const { flags } = redact('-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----');
    expect(flags).not.toContain('private-key');
  });
});

// ── Overlap safety ────────────────────────────────────────────────────────────

describe('overlap and composition', () => {
  it('handles a GH token inside an env line without corruption', () => {
    const input = 'GITHUB_TOKEN=ghp_16C7e42F292c6912E169B7B89B29DCA4BCBA';
    const { text, flags } = redact(input);
    // env-secret and github-token both fire; text must not be corrupted
    expect(flags).toContain('github-token');
    expect(flags).toContain('env-secret');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('DCA4BCB');
  });

  it('applies all rules to a multi-secret blob', () => {
    const input = [
      'AKIAIOSFODNN7EXAMPLE',
      'SLACK_TOKEN=xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt',
    ].join('\n');
    const { flags } = redact(input);
    expect(flags).toContain('aws-access-key');
    expect(flags).toContain('env-secret');
    expect(flags).toContain('slack-token');
  });
});

// ── Property test ─────────────────────────────────────────────────────────────

describe('property: random alphanum never false-positives on structural rules', () => {
  it('random alphanumeric strings do not trigger aws-access-key, github-token, jwt, slack-token, or private-key', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9 _-]{1,200}$/), (s) => {
        const { flags } = redact(s);
        const structuralRules = [
          'aws-access-key',
          'github-token',
          'jwt',
          'slack-token',
          'private-key',
        ];
        for (const rule of structuralRules) {
          expect(flags).not.toContain(rule);
        }
      }),
      { numRuns: 500 },
    );
  });
});
