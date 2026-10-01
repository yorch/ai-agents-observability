import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadHookToken } from './identity';

// A real `aiot login` token is a JWT; use the three-segment shape.
const FILE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaWxlIn0.c2lnLWZpbGU';
const ENV_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlbnYifQ.c2lnLWVudg';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'aiot-identity-test-'));
  process.env.AIOT_HOME = tmpHome;
  delete process.env.AIOT_TOKEN;
});

afterEach(() => {
  rmSync(tmpHome, { force: true, recursive: true });
  delete process.env.AIOT_HOME;
  delete process.env.AIOT_TOKEN;
});

describe('loadHookToken', () => {
  it('reads the token `aiot login` wrote to identity.json', () => {
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: FILE_TOKEN }));
    expect(loadHookToken()).toBe(FILE_TOKEN);
  });

  it('returns null with neither a file nor AIOT_TOKEN', () => {
    expect(loadHookToken()).toBeNull();
  });

  it('uses AIOT_TOKEN when there is no identity file (container case)', () => {
    process.env.AIOT_TOKEN = ENV_TOKEN;
    expect(loadHookToken()).toBe(ENV_TOKEN);
  });

  it('lets AIOT_TOKEN win over the identity file', () => {
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: FILE_TOKEN }));
    process.env.AIOT_TOKEN = ENV_TOKEN;
    expect(loadHookToken()).toBe(ENV_TOKEN);
  });

  it('ignores an empty or whitespace-only AIOT_TOKEN and falls back to the file', () => {
    writeFileSync(join(tmpHome, 'identity.json'), JSON.stringify({ token: FILE_TOKEN }));
    process.env.AIOT_TOKEN = '  \n';
    expect(loadHookToken()).toBe(FILE_TOKEN);
  });

  it('trims a trailing newline from a token injected from a secret file', () => {
    process.env.AIOT_TOKEN = `${ENV_TOKEN}\n`;
    expect(loadHookToken()).toBe(ENV_TOKEN);
  });
});
