import pino, { type Logger } from 'pino';

import type { Config } from '../config';

// Single place that constructs the service logger, so every entrypoint — the HTTP
// server (index.ts) and the standalone jobs (e.g. embed-transcripts) — builds it
// identically: level from config, human-readable pino-pretty transport outside
// production, plain JSON in production.
export function createLogger(config: Pick<Config, 'log_level' | 'node_env'>): Logger {
  return pino({
    level: config.log_level,
    ...(config.node_env !== 'production' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
