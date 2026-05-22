import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PrismaClient } from '@ai-agents-observability/db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Logger } from 'pino';
import { z } from 'zod';

import { objectExists, putObject, type S3Deps, transcriptKey } from '../lib/s3';
import { processTranscript } from '../lib/transcript-pipeline';
import type { AppEnv } from '../types';

const MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024; // 200 MB compressed
const MAX_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MB per chunked PUT
const CONTENT_TYPE_ZSTD = 'application/x-zstd';

const ContentRangeSchema = z
  .string()
  .regex(/^bytes (\d+)-(\d+)\/(\d+)$/)
  .transform((value) => {
    // RFC 7233: bytes start-end/total. Inclusive end.
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
    if (!m) {
      throw new Error('unreachable');
    }
    const [, startStr, endStr, totalStr] = m as unknown as [string, string, string, string];
    return {
      end: Number.parseInt(endStr, 10),
      start: Number.parseInt(startStr, 10),
      total: Number.parseInt(totalStr, 10),
    };
  });

const SessionIdSchema = z.uuid();

type SessionRepo = Pick<PrismaClient, 'session'>;

export type TranscriptsDeps = {
  db: SessionRepo;
  s3: S3Deps;
};

// Parses a Content-Type header value into its bare MIME, dropping parameters
// (charset, boundary, etc.) per RFC 9110 §8.3. Returns null if absent.
function contentTypeMime(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const semi = raw.indexOf(';');
  return (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
}

// Per-session async mutex. Two chunked uploads for the same session must NOT
// interleave on the scratch file (readFile → concat → writeFile is non-atomic).
// Ingest is single-process for v1; an in-memory chain is sufficient.
const sessionLocks = new Map<string, Promise<unknown>>();
async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prior = sessionLocks.get(sessionId) ?? Promise.resolve();
  const ours = prior.then(fn, fn);
  sessionLocks.set(sessionId, ours);
  try {
    return await ours;
  } finally {
    // Only delete if we're still the tail; otherwise a later request has
    // already chained on top of us and owns the entry.
    if (sessionLocks.get(sessionId) === ours) {
      sessionLocks.delete(sessionId);
    }
  }
}

// User-scoped scratch path: a malicious request can't address another user's
// session_id even if they guess one, because the path includes user.id.
function chunkPath(userId: string, sessionId: string): string {
  return join(tmpdir(), `claude-telemetry-transcript-${userId}-${sessionId}.zst.part`);
}

export function transcriptsRouter(deps: TranscriptsDeps, logger: Logger): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post(
    '/:session_id',
    // Hard cap on raw request body. Defends against an authenticated client
    // sending a 10GB body with a fake Content-Range — without this guard the
    // c.req.arrayBuffer() call below would buffer the entire body before any
    // size check could trip. 16 MB matches the chunked upload cap; non-chunked
    // bodies are bound by the same number, which is well under our 200 MB
    // compressed-transcript ceiling and forces clients to chunk.
    bodyLimit({
      maxSize: MAX_CHUNK_BYTES,
      onError: (c) => c.json({ error: 'Request body too large' }, 413),
    }),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json({ error: 'Unauthorized' }, 401);
      }

      const sessionId = c.req.param('session_id');
      const idCheck = SessionIdSchema.safeParse(sessionId);
      if (!idCheck.success) {
        return c.json({ error: 'Invalid session_id' }, 400);
      }

      if (contentTypeMime(c.req.header('content-type')) !== CONTENT_TYPE_ZSTD) {
        return c.json({ error: `Expected Content-Type: ${CONTENT_TYPE_ZSTD}` }, 415);
      }

      // Short-circuit unauthorized requests BEFORE reading the body — see
      // P1-012 implementation note (DoS guard).
      const session = await deps.db.session.findUnique({ where: { sessionId } });
      if (!session) {
        return c.json({ error: 'Session not found' }, 404);
      }
      if (session.userId !== user.id) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      // Key is deterministic from session-stable fields (user_id, session_id,
      // session.started_at). It MUST NOT depend on wall clock — a retry that
      // crosses midnight UTC would otherwise compute a new key and orphan the
      // prior object.
      const key = transcriptKey(user.id, sessionId, session.startedAt);
      const contentRange = c.req.header('content-range');

      return withSessionLock(sessionId, async () => {
        let compressed: Uint8Array;

        if (contentRange) {
          const parsed = ContentRangeSchema.safeParse(contentRange);
          if (!parsed.success) {
            return c.json({ error: 'Invalid Content-Range' }, 400);
          }
          const { start, end, total } = parsed.data;
          if (total > MAX_TRANSCRIPT_BYTES) {
            return c.json({ error: 'Transcript exceeds maximum size' }, 413);
          }
          if (end < start || end >= total) {
            return c.json({ error: 'Invalid Content-Range' }, 400);
          }

          const partPath = chunkPath(user.id, sessionId);
          await mkdir(tmpdir(), { recursive: true });
          const body = new Uint8Array(await c.req.arrayBuffer());
          const expectedLength = end - start + 1;
          if (body.byteLength !== expectedLength) {
            return c.json({ error: 'Content-Range/body length mismatch' }, 400);
          }

          if (start === 0) {
            await writeFile(partPath, body);
          } else {
            const existing = await readFile(partPath).catch(() => null);
            if (!existing || existing.byteLength !== start) {
              return c.json({ error: 'Missing prior chunks for session' }, 409);
            }
            const merged = new Uint8Array(existing.byteLength + body.byteLength);
            merged.set(existing, 0);
            merged.set(body, existing.byteLength);
            await writeFile(partPath, merged);
          }

          if (end + 1 < total) {
            // More chunks expected — ack receipt and wait.
            return c.json({ received: end + 1, total }, 202);
          }

          compressed = new Uint8Array(await readFile(partPath));
          await unlink(partPath).catch(() => {});
        } else {
          compressed = new Uint8Array(await c.req.arrayBuffer());
        }

        const sha256 = createHash('sha256').update(compressed).digest('hex');

        // Idempotency: a prior upload with the same content lives at the same
        // key (key is deterministic by user_id+session_id+session.started_at).
        // If the row already records the same key, return 200 without
        // re-processing.
        if (session.transcriptS3Key === key && session.transcriptUploadedAt) {
          const present = await objectExists(deps.s3, key);
          if (present) {
            return c.json(
              {
                bytes: Number(session.transcriptBytes ?? 0),
                object_key: key,
                redaction_flags: [],
              },
              200,
            );
          }
        }

        const reqId = c.get('requestId');
        const startMs = Date.now();
        const result = processTranscript(compressed);
        await putObject(deps.s3, key, result.recompressed, CONTENT_TYPE_ZSTD);

        await deps.db.session.update({
          data: {
            transcriptBytes: BigInt(result.outputBytes),
            transcriptRedacted: true,
            transcriptS3Key: key,
            transcriptUploadedAt: new Date(),
          },
          where: { sessionId },
        });

        logger.info(
          {
            bytes: result.outputBytes,
            duration_ms: Date.now() - startMs,
            flags: result.redactionFlags,
            reqId,
            sessionId,
            sha256,
          },
          'ingest.transcript.uploaded',
        );

        return c.json(
          {
            bytes: result.outputBytes,
            object_key: key,
            redaction_flags: result.redactionFlags,
          },
          201,
        );
      });
    },
  );

  return router;
}
