import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { redact, scanRedactionMarkers } from '../src/index';

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

// ── AWS secret key ────────────────────────────────────────────────────────────

describe('aws-secret-key', () => {
  it('redacts high-entropy 40-char base64 secrets (positive cassette)', () => {
    const lines = loadCassette('aws-secret-key.txt').split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const { text, flags } = redact(line);
      expect(flags).toContain('aws-secret-key');
      expect(text).toContain('[REDACTED:aws-secret-key]');
    }
  });

  it('does NOT redact low-entropy 40-char strings (entropy gate)', () => {
    for (const low of [
      'A'.repeat(40),
      'ABABABABABABABABABABABABABABABABABABABAB',
      'aaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb',
    ]) {
      const { flags } = redact(low);
      expect(flags).not.toContain('aws-secret-key');
    }
  });

  it('does not match a secret embedded in a longer base64 run (documented boundary)', () => {
    // Known recall limitation: the rule requires the 40-char window to be
    // bounded by non-base64 chars, so a secret concatenated into a longer blob
    // is not matched here (server-side re-scan is the backstop). This test pins
    // the current behaviour so a future change to it is deliberate.
    const embedded = 'aZ3kLp9QvX2mNb7RtY6wEoUiPaSdFgHjKlZxCvBnEXTRA1234';
    const { flags } = redact(embedded);
    expect(flags).not.toContain('aws-secret-key');
  });

  it('runs in linear time on a pathological input (no catastrophic backtracking)', () => {
    const evil = `${'/'.repeat(100_000)}!`;
    const t0 = performance.now();
    redact(evil);
    expect(performance.now() - t0).toBeLessThan(250);
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
        // email / git-remote-url can't match this charset either (no @, ., or
        // ://), so the invariant covers them too.
        const structuralRules = [
          'aws-access-key',
          'github-token',
          'jwt',
          'slack-token',
          'private-key',
          'email',
          'git-remote-url',
        ];
        for (const rule of structuralRules) {
          expect(flags).not.toContain(rule);
        }
      }),
      { numRuns: 500 },
    );
  });
});

// ── scanRedactionMarkers (inverse of makeRule's marker) ───────────────────────

describe('scanRedactionMarkers', () => {
  it('returns the distinct, sorted set of redaction classes found', () => {
    const text =
      'token [REDACTED:github-token] then [REDACTED:aws-access-key] and again [REDACTED:github-token]';
    expect(scanRedactionMarkers(text)).toEqual(['aws-access-key', 'github-token']);
  });

  it('returns an empty array when no markers are present', () => {
    expect(scanRedactionMarkers('a perfectly clean transcript line')).toEqual([]);
  });

  it('does not match malformed or partial markers', () => {
    // Missing closing bracket / empty class / wrong case must not match.
    expect(scanRedactionMarkers('[REDACTED:github-token [REDACTED:] [redacted:jwt]')).toEqual([]);
  });

  // Contract enforcement: whatever classes redact() reports, the markers it
  // leaves behind must be recoverable by scanRedactionMarkers — otherwise the
  // ingest backfill would under-count. Round-trips real cassette secrets.
  it('recovers exactly the classes redact() flagged (round-trip)', () => {
    const line = `${loadCassette('aws-access-key.txt').split('\n')[0]} ${
      loadCassette('github-token.txt').split('\n')[0]
    }`;
    const { text, flags } = redact(line);
    expect(scanRedactionMarkers(text)).toEqual([...flags].sort());
  });
});

// ── Email (PII) ───────────────────────────────────────────────────────────────

describe('email', () => {
  it('redacts all positive cassette examples', () => {
    const lines = loadCassette('email.txt').split('\n');
    for (const line of lines) {
      const { text, flags } = redact(line);
      expect(flags).toContain('email');
      expect(text).toContain('[REDACTED:email]');
    }
  });

  it('does not flag an @handle or a bare domain (no local@domain.tld shape)', () => {
    expect(redact('ping @octocat on the thread').flags).not.toContain('email');
    expect(redact('visit example.com for the docs').flags).not.toContain('email');
  });

  it('leaves clean prose unchanged', () => {
    const clean = 'no addresses in this sentence';
    expect(redact(clean).text).toBe(clean);
  });
});

// ── Git remote URL credentials ────────────────────────────────────────────────

describe('git-remote-url', () => {
  it('redacts userinfo credentials in all positive cassette examples', () => {
    const lines = loadCassette('git-remote-url.txt').split('\n');
    for (const line of lines) {
      const { text, flags } = redact(line);
      expect(flags).toContain('git-remote-url');
      expect(text).toContain('[REDACTED:git-remote-url]@');
    }
  });

  it('preserves scheme + host, redacting only the userinfo', () => {
    const { text } = redact('https://user:pw@github.com/org/repo.git');
    expect(text).toBe('https://[REDACTED:git-remote-url]@github.com/org/repo.git');
  });

  it('does not fire on a credential-free URL', () => {
    expect(redact('clone https://github.com/org/repo.git').flags).not.toContain('git-remote-url');
    // A path containing @ (not userinfo) must not trigger it either.
    expect(redact('GET https://api.example.com/v1/@mentions').flags).not.toContain(
      'git-remote-url',
    );
  });

  it('does not clobber a known token already redacted in the userinfo', () => {
    // github-token runs first and redacts the PAT; git-remote-url must skip the
    // resulting [REDACTED:github-token] marker rather than replacing it.
    const { text, flags } = redact(
      'origin https://ghp_16C7e42F292c6912E169B7B89B29DCA4BCBA@github.com/o/r.git',
    );
    expect(flags).toContain('github-token');
    expect(flags).not.toContain('git-remote-url');
    expect(text).toContain('[REDACTED:github-token]@github.com');
  });
});
