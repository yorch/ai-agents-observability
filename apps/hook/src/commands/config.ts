import {
  type CliConfig,
  cliConfigPath,
  getIngestBaseUrl,
  getWebBaseUrl,
  readCliConfig,
  updateCliConfig,
} from '../lib/config';

const CONFIG_HELP = `claude-telemetry config <command> [key] [value]

Persist the observability server URLs used by login, import, flusher, and shipper.

Commands:
  show                         Show effective URLs and their source
  path                         Print the config file path
  set <web-url|ingest-url> URL Persist a URL
  unset <web-url|ingest-url>   Remove a persisted URL
  -h, --help                   Show this help

Environment variables override persisted values:
  CLAUDE_TELEMETRY_API         Web application URL
  INGEST_BASE_URL              Ingest service URL`;

const CONFIG_KEYS = {
  'ingest-url': 'ingest_url',
  'web-url': 'web_url',
} as const satisfies Record<string, keyof CliConfig>;

function sourceFor(envName: string, key: keyof CliConfig, config: CliConfig): string {
  if (process.env[envName]) {
    return envName;
  }
  return config[key] ? cliConfigPath() : 'default';
}

export function runConfig(args: string[]): number {
  const command = args[1];
  if (!command || command === 'show') {
    try {
      const config = readCliConfig();
      process.stdout.write(`config_file=${cliConfigPath()}\n`);
      process.stdout.write(
        `web_url=${getWebBaseUrl()} (${sourceFor('CLAUDE_TELEMETRY_API', 'web_url', config)})\n`,
      );
      process.stdout.write(
        `ingest_url=${getIngestBaseUrl()} (${sourceFor('INGEST_BASE_URL', 'ingest_url', config)})\n`,
      );
      return 0;
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (command === '-h' || command === '--help') {
    process.stdout.write(`${CONFIG_HELP}\n`);
    return 0;
  }
  if (command === 'path') {
    process.stdout.write(`${cliConfigPath()}\n`);
    return 0;
  }

  const keyArg = args[2];
  const key = keyArg ? CONFIG_KEYS[keyArg as keyof typeof CONFIG_KEYS] : undefined;
  if ((command !== 'set' && command !== 'unset') || !key) {
    process.stderr.write(`${CONFIG_HELP}\n`);
    return 1;
  }

  try {
    if (command === 'unset') {
      updateCliConfig({ [key]: null });
      process.stdout.write(`Removed ${keyArg} from ${cliConfigPath()}\n`);
      return 0;
    }
    const value = args[3];
    if (!value) {
      process.stderr.write(`Error: config set ${keyArg} requires a URL\n`);
      return 1;
    }
    const updated = updateCliConfig({ [key]: value });
    process.stdout.write(`Saved ${keyArg}=${updated[key]} to ${cliConfigPath()}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}
