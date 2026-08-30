import type { Event } from '@ai-agents-observability/schemas';

import { getIngestBaseUrl } from '../lib/config';
import { loadHookToken } from '../lib/identity';
import { AuthError, checkServerReady, postEventBatch, uploadTranscript } from '../lib/import-ship';
import {
  type HistoricalSession,
  IMPORT_AGENTS,
  type ImportAgent,
  importSource,
} from '../lib/import-source';

const BATCH_SIZE = 100;

export type ImportOptions = {
  agent: ImportAgent;
  dryRun: boolean;
  noTranscripts: boolean;
  quiet: boolean;
  sessionId: string | null;
  since: Date | null;
};

const IMPORT_HELP = `aiot import [options]

Import historical coding-agent sessions into the observability server. Events and
transcripts are deduplicated server-side and deterministic client-side — safe to re-run.

Options:
  --agent <name>          claude-code (default), codex, opencode, pi, or omp
  --since <YYYY-MM-DD>    Only import events on or after this date
  --session <id>          Import only this native or normalized session ID
  --no-transcripts        Import events only; skip transcript uploads
  --dry-run               Parse and count; do not POST anything (no auth required)
  --quiet                 Suppress per-session output
  -h, --help              Show this help

Configuration:
  aiot config set ingest-url <url>
  INGEST_BASE_URL overrides the persisted ingest URL.

Source overrides:
  CLAUDE_PROJECTS_DIR, CODEX_HOME, OPENCODE_DATA, PI_HOME, OMP_HOME

Requires \`aiot login\` first (except --dry-run).`;

function parseImportArgs(args: string[]): ImportOptions | 'help' | 'error' {
  if (args.includes('-h') || args.includes('--help')) {
    return 'help';
  }

  let agent: ImportAgent = 'claude-code';
  let dryRun = false;
  let noTranscripts = false;
  let quiet = false;
  let sessionId: string | null = null;
  let since: Date | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-transcripts') {
      noTranscripts = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--agent') {
      const value = args[++i];
      if (!value || !IMPORT_AGENTS.includes(value as ImportAgent)) {
        process.stderr.write(`Error: --agent must be one of: ${IMPORT_AGENTS.join(', ')}\n`);
        return 'error';
      }
      agent = value as ImportAgent;
    } else if (arg.startsWith('--agent=')) {
      const value = arg.slice('--agent='.length);
      if (!IMPORT_AGENTS.includes(value as ImportAgent)) {
        process.stderr.write(`Error: --agent must be one of: ${IMPORT_AGENTS.join(', ')}\n`);
        return 'error';
      }
      agent = value as ImportAgent;
    } else if (arg === '--since') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        process.stderr.write('Error: --since requires a date argument (YYYY-MM-DD)\n');
        return 'error';
      }
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        process.stderr.write(`Error: invalid --since date: ${value}\n`);
        return 'error';
      }
      since = parsed;
    } else if (arg === '--session') {
      const value = args[++i];
      if (!value || value.startsWith('-')) {
        process.stderr.write('Error: --session requires an ID argument\n');
        return 'error';
      }
      sessionId = value;
    }
  }

  return { agent, dryRun, noTranscripts, quiet, sessionId, since };
}

export async function runImport(args: string[]): Promise<number> {
  const parsed = parseImportArgs(args.slice(1));
  if (parsed === 'help') {
    process.stdout.write(`${IMPORT_HELP}\n`);
    return 0;
  }
  if (parsed === 'error') {
    return 1;
  }
  const opts = parsed;
  let ingestBaseUrl: string | null = null;
  if (!opts.dryRun) {
    try {
      ingestBaseUrl = getIngestBaseUrl();
    } catch (err) {
      process.stderr.write(`Configuration error: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const jwt = opts.dryRun ? null : loadHookToken();
  if (!jwt && !opts.dryRun) {
    process.stderr.write('Not authenticated. Run `aiot login` first.\n');
    return 1;
  }

  if (!opts.dryRun) {
    const ready = await checkServerReady(ingestBaseUrl as string);
    if (!ready.ok) {
      process.stderr.write(`Error: ${ready.message}\n`);
      return 1;
    }
  }

  const source = importSource(opts.agent);
  if (!source) {
    process.stderr.write(`Historical import is not supported for ${opts.agent}.\n`);
    return 1;
  }

  let sessions: HistoricalSession[];
  try {
    sessions = source
      .discover()
      .filter(
        (session) =>
          !opts.sessionId ||
          session.nativeSessionId === opts.sessionId ||
          session.sessionId === opts.sessionId,
      );
  } catch (err) {
    process.stderr.write(`Cannot discover ${opts.agent} sessions: ${(err as Error).message}\n`);
    return 1;
  }

  if (sessions.length === 0) {
    if (!opts.quiet) {
      process.stdout.write(`No ${opts.agent} sessions found.\n`);
    }
    return 0;
  }
  if (!opts.quiet) {
    process.stdout.write(`Discovered ${sessions.length} ${opts.agent} session candidate(s).\n`);
  }

  let totalAccepted = 0;
  let totalDeduped = 0;
  let totalErrors = 0;
  let totalRejected = 0;
  let totalSessions = 0;
  let totalTranscripts = 0;

  for (const session of sessions) {
    try {
      const events = await session.events(opts.since);
      if (events.length === 0) {
        continue;
      }
      totalSessions += 1;
      let sessionAccepted = 0;
      let sessionDeduped = 0;
      let sessionRejected = 0;

      if (opts.dryRun) {
        sessionAccepted = events.length;
      } else {
        const pending: Event[] = [...events];
        while (pending.length > 0) {
          const batch = pending.splice(0, BATCH_SIZE);
          const result = await postEventBatch(batch, jwt as string, ingestBaseUrl as string);
          sessionAccepted += result.accepted;
          sessionDeduped += result.deduped;
          sessionRejected += result.rejected;
        }
      }

      totalAccepted += sessionAccepted;
      totalDeduped += sessionDeduped;
      totalRejected += sessionRejected;

      let transcriptStatus = 'skipped';
      if (!opts.noTranscripts && !opts.dryRun && jwt) {
        const prepared = session.prepareTranscript();
        if (prepared) {
          try {
            const result = await uploadTranscript(
              session.sessionId,
              prepared.path,
              jwt,
              ingestBaseUrl as string,
            );
            if (result.ok) {
              transcriptStatus = `ok (${result.bytes} bytes)`;
              totalTranscripts += 1;
            } else {
              transcriptStatus = `${result.reason}: ${result.message}`;
            }
          } finally {
            prepared.cleanup?.();
          }
        }
      }

      if (!opts.quiet) {
        const eventSummary = opts.dryRun
          ? `would import ${sessionAccepted}`
          : `accepted=${sessionAccepted} deduped=${sessionDeduped} rejected=${sessionRejected}`;
        process.stdout.write(
          `  ${session.sessionId}  events: ${eventSummary}  transcript: ${transcriptStatus}\n`,
        );
      }
    } catch (err) {
      if (err instanceof AuthError) {
        process.stderr.write(`Authentication error: ${(err as Error).message}\n`);
        return 1;
      }
      totalErrors += 1;
      if (!opts.quiet) {
        process.stderr.write(`  WARNING: ${session.sessionId} — ${(err as Error).message}\n`);
      }
    }
  }

  if (!opts.quiet) {
    if (opts.dryRun) {
      process.stdout.write(
        `\nDry run complete. Would import ${totalAccepted} events from ${totalSessions} sessions.\n`,
      );
    } else {
      process.stdout.write(
        `\nImport complete: ${totalAccepted} accepted, ${totalDeduped} deduped, ${totalRejected} rejected, ${totalTranscripts} transcripts uploaded.\n`,
      );
    }
    if (totalErrors > 0) {
      process.stdout.write(`${totalErrors} session(s) had errors (see warnings above).\n`);
    }
  }

  return 0;
}
