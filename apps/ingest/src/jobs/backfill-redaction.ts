import type { PrismaClient } from '@ai-agents-observability/db';
import { Prisma } from '@ai-agents-observability/db';
import { scanRedactionMarkers } from '@ai-agents-observability/redaction';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import { downloadAndParseTranscript } from './index-transcripts';
import { type JobRunDb, withJobRun } from './job-run';

// jobRun + $queryRaw come from JobRunDb (the shared job scaffold); this job also
// reads `session` rows and issues a parameterized UPDATE.
export type DbWithRaw = JobRunDb &
  Pick<PrismaClient, 'session'> & {
    $executeRaw: PrismaClient['$executeRaw'];
  };

// Page size for the keyset walk below. Caps how many candidate rows are held in
// memory (and how many transcripts are downloaded) at once; the job pages
// through the whole eligible set in one invocation.
const PAGE = 500;

// Independent, read-only S3 GETs within a page run concurrently up to this many
// in flight — cuts the wall-clock of a large backlog without hammering S3.
const DOWNLOAD_CONCURRENCY = 8;

type BackfillRow = { session_id: string; started_at: Date; transcript_s3_key: string };

/**
 * Operator-triggered one-shot: backfills `sessions.redaction_flags` for
 * sessions whose transcript was archived before that column existed.
 * Redaction always ran at ingest time — only the per-session flag summary is
 * missing — so this scans the stored (already-redacted) transcript text for
 * `[REDACTED:<class>]` markers left behind by the pipeline (via the shared
 * scanRedactionMarkers from packages/redaction), rather than re-running
 * redaction against it.
 *
 * Drains the whole eligible backlog in a single invocation via a keyset walk
 * over `(started_at, session_id)`. A plain `LIMIT` on `cardinality = 0` would
 * NOT drain: sessions that scan clean keep `redaction_flags` empty and so stay
 * in the candidate set, meaning a block of clean sessions would refill the same
 * page every run and the job would never reach the older un-backfilled ones.
 * Advancing the cursor past every row we look at — flagged or not — guarantees
 * forward progress and termination while capping memory at `PAGE` rows.
 */
export async function runBackfillRedaction(
  db: DbWithRaw,
  s3: S3Client,
  bucket: string,
  logger?: Logger,
): Promise<void> {
  const jobName = 'backfill-redaction';

  await withJobRun(db, jobName, logger, async () => {
    let candidates = 0;
    let scanned = 0;
    let flagged = 0;
    let skipped = 0;
    let failed = 0;

    // Download + scan + (conditionally) flag one session. Counters are mutated
    // via closure; safe under concurrency since JS runs these to completion
    // without preemption between increments.
    const processRow = async (row: BackfillRow): Promise<void> => {
      try {
        const messages = await downloadAndParseTranscript(
          s3,
          bucket,
          row.transcript_s3_key,
          logger,
        );
        if (messages === null) {
          skipped++;
          return;
        }

        // Scan the FULL serialized message, not just text blocks: the forward
        // redaction pipeline runs `redact()` over the entire raw JSONL line, so
        // markers can sit in tool-call inputs/results too. Each message is the
        // whole parsed line, so re-stringifying it reproduces that surface (a
        // text-only scan would miss those markers and under-count classes).
        const text = messages.map((m) => JSON.stringify(m)).join(' ');
        scanned++;

        const flags = scanRedactionMarkers(text);
        if (flags.length > 0) {
          await db.$executeRaw(Prisma.sql`
            UPDATE sessions
            SET redaction_flags = ${flags}::text[]
            WHERE session_id = ${row.session_id}::uuid
          `);
          flagged++;
        }
      } catch (err) {
        failed++;
        logger?.warn({ err, sessionId: row.session_id }, 'Failed to backfill redaction flags');
      }
    };

    // Keyset cursor over (started_at, session_id) — a tuple so sessions sharing
    // an exact started_at can't be skipped at a page boundary.
    let cursor: { id: string; ts: Date } | null = null;

    for (;;) {
      const rows = await db.$queryRaw<BackfillRow[]>(Prisma.sql`
        SELECT s.session_id, s.started_at, s.transcript_s3_key
        FROM sessions s
        WHERE s.transcript_s3_key IS NOT NULL
          AND cardinality(s.redaction_flags) = 0
          ${
            cursor
              ? Prisma.sql`AND (s.started_at, s.session_id) < (${cursor.ts}, ${cursor.id}::uuid)`
              : Prisma.empty
          }
        ORDER BY s.started_at DESC, s.session_id DESC
        LIMIT ${PAGE}
      `);

      if (rows.length === 0) {
        break;
      }
      candidates += rows.length;
      const last = rows[rows.length - 1] as BackfillRow;
      cursor = { id: last.session_id, ts: last.started_at };

      for (let i = 0; i < rows.length; i += DOWNLOAD_CONCURRENCY) {
        await Promise.all(rows.slice(i, i + DOWNLOAD_CONCURRENCY).map(processRow));
      }

      if (rows.length < PAGE) {
        break;
      }
    }

    // Every candidate errored → a systemic failure (S3 unreachable / bad creds),
    // not a clean drain. Surface it as a failed run rather than a green one
    // (parity with sync-jira), but only when we actually attempted work.
    if (candidates > 0 && failed === candidates) {
      throw new Error(`backfill-redaction: all ${failed} transcript scans failed`);
    }

    logger?.info(
      { candidates, failed, flagged, jobName, scanned, skipped },
      'Redaction-flag backfill complete',
    );
  });
}
