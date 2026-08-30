import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runConfig } from '../commands/config';
import { runLogin } from '../commands/login';
import {
  DEFAULT_INGEST_BASE_URL,
  DEFAULT_WEB_BASE_URL,
  getIngestBaseUrl,
  getWebBaseUrl,
  readCliConfig,
  updateCliConfig,
} from './config';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aiot-config-'));
  path = join(dir, 'nested', 'config.json');
  process.env.AIOT_CONFIG = path;
  delete process.env.AIOT_API;
  delete process.env.INGEST_BASE_URL;
});

afterEach(() => {
  delete process.env.AIOT_API;
  delete process.env.AIOT_CONFIG;
  delete process.env.INGEST_BASE_URL;
  rmSync(dir, { force: true, recursive: true });
});

describe('persisted CLI config', () => {
  it('uses localhost defaults when no config exists', () => {
    expect(getWebBaseUrl()).toBe(DEFAULT_WEB_BASE_URL);
    expect(getIngestBaseUrl()).toBe(DEFAULT_INGEST_BASE_URL);
  });

  it('persists normalized URLs with owner-only permissions', () => {
    updateCliConfig({
      ingest_url: 'https://ingest.example.com/',
      web_url: 'https://observability.example.com/',
    });

    expect(readCliConfig()).toEqual({
      ingest_url: 'https://ingest.example.com',
      web_url: 'https://observability.example.com',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('lets environment variables override persisted URLs', () => {
    updateCliConfig({ ingest_url: 'https://saved.example.com' });
    process.env.INGEST_BASE_URL = 'https://override.example.com/';
    expect(getIngestBaseUrl()).toBe('https://override.example.com');
  });

  it('rejects credentials and non-http URL schemes', () => {
    expect(() => updateCliConfig({ web_url: 'file:///tmp/server' })).toThrow();
    expect(() => updateCliConfig({ web_url: 'https://user:pass@example.com' })).toThrow();
  });

  it('reports malformed persisted JSON instead of silently using localhost', () => {
    updateCliConfig({ web_url: 'https://example.com' });
    writeFileSync(path, '{not json', { encoding: 'utf8', mode: 0o600 });
    expect(() => readCliConfig()).toThrow(/Cannot read CLI config/);
  });

  it('turns malformed config into a login error instead of an unhandled rejection', async () => {
    updateCliConfig({ web_url: 'https://example.com' });
    writeFileSync(path, '{not json', { encoding: 'utf8', mode: 0o600 });
    expect(await runLogin()).toBe(1);
  });

  it('supports config set and unset commands', () => {
    expect(runConfig(['config', 'set', 'ingest-url', 'https://ingest.example.com/'])).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).ingest_url).toBe('https://ingest.example.com');
    expect(runConfig(['config', 'unset', 'ingest-url'])).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8')).ingest_url).toBeUndefined();
  });
});
