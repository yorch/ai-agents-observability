import { gunzipSync, zstdDecompressSync } from 'node:zlib';

import type { PrismaClient } from '@ai-agents-observability/db';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

type DbWithRaw = Pick<PrismaClient, 'session' | 'jobRun'> & {
  $executeRawUnsafe: PrismaClient['$executeRawUnsafe'];
  $queryRaw: PrismaClient['$queryRaw'];
};

type TranscriptMessage = {
  content?: unknown;
  role?: string;
  timestamp?: string;
};

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') {
            return b.text;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/**
 * Indexes transcript content into the transcript_index FTS table.
 * Processes sessions that have a transcript uploaded but no index rows yet.
 * Runs nightly; uses advisory lock to prevent concurrent runs.
 */
export async function runIndexTranscripts(
  db: DbWithRaw,
  s3: S3Client,
  bucket: string,
  logger?: Logger,
): Promise<void> {
  const jobName = 'index-transcripts';
  const startedAt = new Date();

  const lockResult = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${jobName}`}))
  `;
  if (!lockResult[0]?.pg_try_advisory_lock) {
    logger?.warn({ jobName }, 'Advisory lock not acquired, skipping');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({
      data: { jobName, startedAt, status: 'running' },
    });
    jobRunId = jobRun.id;

    // Find sessions with transcripts that have no index entries yet (batch 200)
    const unindexed = await db.$queryRaw<{ session_id: string; transcript_s3_key: string }[]>`
      SELECT s.session_id, s.transcript_s3_key
      FROM sessions s
      WHERE s.transcript_s3_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM transcript_index ti WHERE ti.session_id = s.session_id::uuid
        )
      LIMIT 200
    `;

    let indexed = 0;
    for (const row of unindexed) {
      try {
        const obj = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: row.transcript_s3_key }),
        );
        if (!obj.Body) {
          continue;
        }

        const compressed = Buffer.from(await obj.Body.transformToByteArray());

        // Guard against unexpectedly large or corrupt S3 objects
        const MAX_COMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
        if (compressed.length > MAX_COMPRESSED_BYTES) {
          logger?.warn(
            { bytes: compressed.length, key: row.transcript_s3_key },
            'Transcript too large to index, skipping',
          );
          continue;
        }

        let decompressed: Buffer;
        try {
          decompressed = zstdDecompressSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
        } catch {
          try {
            decompressed = gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 });
          } catch {
            logger?.warn(
              { key: row.transcript_s3_key },
              'Failed to decompress transcript, skipping',
            );
            continue;
          }
        }

        const text = new TextDecoder('utf-8').decode(decompressed);
        const lines = text.split('\n').filter((l) => l.trim());

        const messages: TranscriptMessage[] = [];
        for (const line of lines) {
          try {
            messages.push(JSON.parse(line) as TranscriptMessage);
          } catch {
            // Skip malformed lines
          }
        }

        // Insert FTS rows in a batch (one per message with text content)
        let hasInserted = false;
        for (const [msgIdx, msg] of messages.entries()) {
          const role = typeof msg.role === 'string' ? msg.role : 'unknown';
          const contentText = extractTextContent(msg.content);
          if (!contentText.trim()) {
            continue;
          }
          const ts = typeof msg.timestamp === 'string' ? new Date(msg.timestamp) : null;

          await db.$executeRawUnsafe(
            `INSERT INTO transcript_index (session_id, message_idx, role, ts, content_text)
             VALUES ($1::uuid, $2, $3, $4, $5)
             ON CONFLICT (session_id, message_idx) DO NOTHING`,
            row.session_id,
            msgIdx,
            role,
            ts,
            contentText.slice(0, 100_000), // cap per-message to avoid huge rows
          );
          hasInserted = true;
        }

        // If the transcript had no indexable text at all, insert a sentinel so this
        // session is not re-selected on every nightly run (NOT EXISTS check).
        if (!hasInserted) {
          await db.$executeRawUnsafe(
            `INSERT INTO transcript_index (session_id, message_idx, role, ts, content_text)
             VALUES ($1::uuid, -1, '__empty__', null, ' ')
             ON CONFLICT (session_id, message_idx) DO NOTHING`,
            row.session_id,
          );
        }

        indexed++;
      } catch (err) {
        logger?.warn({ err, sessionId: row.session_id }, 'Failed to index transcript');
      }
    }

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });

    logger?.info({ indexed, jobName, total: unindexed.length }, 'Transcript indexing complete');
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger?.error({ err, jobName }, 'Transcript indexing job failed');
    if (jobRunId !== undefined) {
      await db.jobRun
        .update({
          data: { errorText, finishedAt: new Date(), status: 'error' },
          where: { id: jobRunId },
        })
        .catch(() => {});
    }
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`job:${jobName}`}))`.catch(() => {});
  }
}
