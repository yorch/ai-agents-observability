import type { Event } from '@ai-agents-observability/schemas';

import { listSessionFiles } from '../lib/claude-projects';
import { loadHookToken } from '../lib/identity';
import { AuthError, postEventBatch, uploadTranscript } from '../lib/import-ship';
import { createSynthCtx, entryToEvents } from '../lib/import-synth';
import { parseSessionFile } from '../lib/transcript-parser';

const BATCH_SIZE = 100;

export type ImportOptions = {
  dryRun: boolean;
  since: Date | null; // --since YYYY-MM-DD
  sessionId: string | null; // --session <id>
  noTranscripts: boolean; // --no-transcripts
  quiet: boolean;
};

const IMPORT_HELP = `claude-telemetry import [options]

Import historical Claude Code sessions from ~/.claude/projects into the
observability server. Events and transcripts are deduplicated server-side —
safe to re-run.

Options:
  --since <YYYY-MM-DD>    Only import entries on or after this date
  --session <id>          Import only the session with this ID
  --no-transcripts        Import events only; skip transcript uploads
  --dry-run               Parse and count; do not POST anything (no auth required)
  --quiet                 Suppress per-session output
  -h, --help              Show this help

Environment:
  CLAUDE_PROJECTS_DIR     Override ~/.claude/projects (default)
  INGEST_BASE_URL         Override http://localhost:4000 (default)

Requires \`claude-telemetry login\` first (except --dry-run).`;

function parseImportArgs(args: string[]): ImportOptions | 'help' {
  if (args.includes('-h') || args.includes('--help')) {
    return 'help';
  }

  let dryRun = false;
  let since: Date | null = null;
  let sessionId: string | null = null;
  let noTranscripts = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--no-transcripts') {
      noTranscripts = true;
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '--since') {
      const val = args[i + 1];
      if (!val || val.startsWith('-')) {
        process.stderr.write('Error: --since requires a date argument (YYYY-MM-DD)\n');
        return 'help';
      }
      i++;
      const parsed = new Date(val);
      if (Number.isNaN(parsed.getTime())) {
        process.stderr.write(`Error: invalid --since date: ${val}\n`);
        return 'help';
      }
      since = parsed;
    } else if (arg === '--session') {
      const val = args[i + 1];
      if (!val || val.startsWith('-')) {
        process.stderr.write('Error: --session requires an ID argument\n');
        return 'help';
      }
      i++;
      sessionId = val;
    }
    // ignore unknown flags / positionals
  }

  return { dryRun, noTranscripts, quiet, sessionId, since };
}

export async function runImport(args: string[]): Promise<number> {
  const parseResult = parseImportArgs(args.filter((a) => a !== 'import')); // remove 'import' positional
  if (parseResult === 'help') {
    process.stdout.write(`${IMPORT_HELP}\n`);
    return 0;
  }
  const opts: ImportOptions = parseResult;

  // Auth check (skip for --dry-run)
  const rawJwt = opts.dryRun ? null : loadHookToken();
  if (!rawJwt && !opts.dryRun) {
    process.stderr.write('Not authenticated. Run `claude-telemetry login` first.\n');
    return 1;
  }
  // After the early return above, rawJwt is either null (dryRun) or a valid string.
  // Cast to string for use in non-dryRun paths.
  const jwt: string | null = rawJwt;

  // Discover session files
  const files = listSessionFiles();
  const filtered = files.filter((f) => {
    if (opts.sessionId && f.sessionId !== opts.sessionId) {
      return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    if (!opts.quiet) {
      process.stdout.write('No sessions found.\n');
    }
    return 0;
  }

  if (!opts.quiet) {
    process.stdout.write(`Found ${filtered.length} session(s) to import.\n`);
  }

  // Per-session totals for summary
  let totalAccepted = 0;
  let totalDeduped = 0;
  let totalRejected = 0;
  let totalTranscripts = 0;
  let totalErrors = 0;

  for (const file of filtered) {
    try {
      // --- Event synthesis ---
      let sessionId = file.sessionId;
      let cwd = process.cwd();
      let version: string | null = null;
      let ctx = createSynthCtx(sessionId, cwd, version);
      const batch: Event[] = [];
      let sessionAccepted = 0;
      let sessionDeduped = 0;
      let sessionRejected = 0;
      let contextResolved = false;

      async function flushBatch(force = false): Promise<void> {
        if (batch.length === 0) {
          return;
        }
        if (!force && batch.length < BATCH_SIZE) {
          return;
        }
        if (opts.dryRun) {
          sessionAccepted += batch.length;
          batch.length = 0;
          return;
        }
        // jwt is non-null here because dryRun=false was checked above
        const token = jwt as string;
        while (batch.length >= BATCH_SIZE) {
          const slice = batch.splice(0, BATCH_SIZE);
          const result = await postEventBatch(slice, token);
          sessionAccepted += result.accepted;
          sessionDeduped += result.deduped;
          sessionRejected += result.rejected;
        }
        if (force && batch.length > 0) {
          const slice = batch.splice(0, batch.length);
          const result = await postEventBatch(slice, token);
          sessionAccepted += result.accepted;
          sessionDeduped += result.deduped;
          sessionRejected += result.rejected;
        }
      }

      for await (const entry of parseSessionFile(file.path)) {
        // Update ctx from the first entry that has context fields
        if (!contextResolved) {
          if (entry.sessionId) {
            sessionId = entry.sessionId;
          }
          if (entry.cwd) {
            cwd = entry.cwd;
          }
          if (entry.version) {
            version = entry.version;
          }
          ctx = createSynthCtx(sessionId, cwd, version);
          contextResolved = true;
        }

        // Apply --since filter using timestamp of entry
        if (opts.since && entry.timestamp) {
          const entryDate = new Date(entry.timestamp);
          if (entryDate < opts.since) {
            continue;
          }
        }

        const events = entryToEvents(entry, ctx);
        batch.push(...events);
        while (batch.length >= BATCH_SIZE) {
          await flushBatch();
        }
      }
      await flushBatch(true); // flush remainder

      totalAccepted += sessionAccepted;
      totalDeduped += sessionDeduped;
      totalRejected += sessionRejected;

      // --- Transcript upload ---
      let transcriptStatus = 'skipped';
      if (!opts.noTranscripts && !opts.dryRun && jwt) {
        const result = await uploadTranscript(sessionId, file.path, jwt);
        if (result.ok) {
          transcriptStatus = `ok (${result.bytes} bytes)`;
          totalTranscripts++;
        } else {
          transcriptStatus = `${result.reason}: ${result.message}`;
        }
      }

      if (!opts.quiet) {
        const eventSummary = opts.dryRun
          ? `would import ~${sessionAccepted}`
          : `accepted=${sessionAccepted} deduped=${sessionDeduped} rejected=${sessionRejected}`;
        process.stdout.write(
          `  ${sessionId}  events: ${eventSummary}  transcript: ${transcriptStatus}\n`,
        );
      }
    } catch (err) {
      if (err instanceof AuthError) {
        process.stderr.write(`Authentication error: ${(err as Error).message}\n`);
        return 1;
      }
      // Per-session error: warn and continue
      totalErrors++;
      if (!opts.quiet) {
        process.stderr.write(`  WARNING: ${file.sessionId} — ${(err as Error).message}\n`);
      }
    }
  }

  // Summary
  if (!opts.quiet) {
    if (opts.dryRun) {
      process.stdout.write(
        `\nDry run complete. Would import ~${totalAccepted} events from ${filtered.length} sessions.\n`,
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
