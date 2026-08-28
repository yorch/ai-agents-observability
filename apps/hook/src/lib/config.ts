import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_INGEST_BASE_URL = 'http://localhost:4000';
export const DEFAULT_WEB_BASE_URL = 'http://localhost:3000';

export type CliConfig = {
  ingest_url?: string;
  web_url?: string;
};

export function cliConfigPath(): string {
  if (process.env.CLAUDE_TELEMETRY_CONFIG) {
    return process.env.CLAUDE_TELEMETRY_CONFIG;
  }
  const root = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(root, 'claude-telemetry', 'config.json');
}

export function readCliConfig(): CliConfig {
  try {
    const parsed = JSON.parse(readFileSync(cliConfigPath(), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    const raw = parsed as Record<string, unknown>;
    return {
      ...(typeof raw.ingest_url === 'string' ? { ingest_url: normalizeUrl(raw.ingest_url) } : {}),
      ...(typeof raw.web_url === 'string' ? { web_url: normalizeUrl(raw.web_url) } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Cannot read CLI config at ${cliConfigPath()}: ${(err as Error).message}`);
  }
}

export function getIngestBaseUrl(): string {
  return normalizeUrl(
    process.env.INGEST_BASE_URL ?? readCliConfig().ingest_url ?? DEFAULT_INGEST_BASE_URL,
  );
}

export function getWebBaseUrl(): string {
  return normalizeUrl(
    process.env.CLAUDE_TELEMETRY_API ?? readCliConfig().web_url ?? DEFAULT_WEB_BASE_URL,
  );
}

export function writeCliConfig(config: CliConfig): void {
  const path = cliConfigPath();
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

export function updateCliConfig(
  update: Partial<Record<keyof CliConfig, string | null>>,
): CliConfig {
  const next = { ...readCliConfig() };
  for (const [key, value] of Object.entries(update) as Array<
    [keyof CliConfig, string | null | undefined]
  >) {
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = normalizeUrl(value);
    }
  }
  writeCliConfig(next);
  return next;
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('URL must not contain credentials, a query string, or a fragment');
  }
  return value.replace(/\/+$/, '');
}
