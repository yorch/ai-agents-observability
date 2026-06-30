import pino from 'pino';

// Server-side structured logger for the web app. This is foundational: it is
// imported by modules that run before — or independently of — full config
// validation (`getConfig`), so it reads `LOG_LEVEL` directly rather than going
// through the Zod-validated config. A bad/missing level must never crash a
// request, so we fall back to `info`.
//
// Plain pino with no transport: the `pino-pretty` worker-thread transport does
// not bundle cleanly into the Next.js standalone build, and JSON-to-stdout
// matches how `apps/ingest` and `apps/github-app` log in production. Keep this
// module server-only — never import it from a `'use client'` module.
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
type LogLevel = (typeof LEVELS)[number];

function resolveLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  return (LEVELS as readonly string[]).includes(raw ?? '') ? (raw as LogLevel) : 'info';
}

export const logger = pino({ level: resolveLevel() });
