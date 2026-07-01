/* PROTOTYPE — not scheduled. Run manually to populate transcript_embeddings.
   Requires: SEMANTIC_SEARCH_ENABLED=1, OPENAI_API_KEY, DATABASE_URL, S3_* vars.
   Usage:
     bun run apps/ingest/src/jobs/embed-transcripts.ts [--sample N] [--measure]
   --sample N  : only process N sessions (default: all unembedded)
   --measure   : after embedding, run 20 representative queries and compare
                 Jaccard overlap vs keyword FTS, writing results to
                 tasks/P7-007-overlap-results.json
*/

import { createClient } from '@ai-agents-observability/db';
import { S3Client } from '@aws-sdk/client-s3';
import type { Logger } from 'pino';

import { loadConfig } from '../config';
import { createLogger } from '../lib/logger';
import { downloadAndParseTranscript, extractTextContent } from './index-transcripts';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 1536;
const CHUNK_TARGET_CHARS = 4000;
const CHUNK_OVERLAP_CHARS = 400;
const MAX_CHUNKS_PER_SESSION = 50;
const BATCH_SIZE = 64;
const BATCH_SLEEP_MS = 200;
const JOB_NAME = 'embed-transcripts-prototype';

const MEASURE_QUERIES = [
  'fix typescript error',
  'add unit tests',
  'refactor database schema',
  'implement authentication',
  'debug memory leak',
  'optimize SQL query',
  'update dependencies',
  'add error handling',
  'write documentation',
  'deploy to production',
  'review pull request',
  'merge conflicts',
  'add new feature',
  'fix failing tests',
  'improve performance',
  'configure CI pipeline',
  'setup environment variables',
  'create API endpoint',
  'handle edge cases',
  'code review feedback',
];

type Chunk = { chunkIndex: number; text: string };

function chunkText(text: string): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let current = '';
  let chunkIndex = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      continue;
    }

    if (current.length + trimmed.length + 2 > CHUNK_TARGET_CHARS && current.length > 0) {
      chunks.push({ chunkIndex: chunkIndex++, text: current.trim() });
      if (chunks.length >= MAX_CHUNKS_PER_SESSION) {
        break;
      }
      current = `${current.slice(-CHUNK_OVERLAP_CHARS)}\n\n${trimmed}`;
    } else {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
    }
  }

  if (current.trim() && chunks.length < MAX_CHUNKS_PER_SESSION) {
    chunks.push({ chunkIndex: chunkIndex++, text: current.trim() });
  }

  return chunks;
}

async function embedBatch(
  texts: string[],
  apiKey: string,
  logger: Logger,
): Promise<number[][] | null> {
  let backoff = 1000;

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      body: JSON.stringify({ dimensions: EMBED_DIMS, input: texts, model: EMBED_MODEL }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });

    if (res.status === 429) {
      logger.warn({ attempt, backoff }, 'OpenAI rate limit, backing off');
      await new Promise((r) => setTimeout(r, backoff));
      backoff *= 2;
      continue;
    }

    if (!res.ok) {
      logger.error({ status: res.status }, 'OpenAI embedding request failed');
      return null;
    }

    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }

  logger.error('Exhausted OpenAI retries');
  return null;
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function jaccard(setA: Set<string>, setB: Set<string>): number {
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function parseArgs(argv: string[]): { measure: boolean; sample: number | null } {
  let sample: number | null = null;
  let measure = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sample' && argv[i + 1]) {
      sample = Number(argv[++i]);
    } else if (argv[i] === '--measure') {
      measure = true;
    }
  }

  return { measure, sample };
}

async function runEmbedTranscripts(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  if (!config.semantic_search_enabled) {
    logger.error(
      'SEMANTIC_SEARCH_ENABLED is not set. Set it to "1" or "true" to run this prototype.',
    );
    process.exit(1);
  }

  if (!config.openai_api_key) {
    logger.error('OPENAI_API_KEY is required for embedding.');
    process.exit(1);
  }
  const openaiApiKey: string = config.openai_api_key;

  const { measure, sample } = parseArgs(process.argv.slice(2));

  const db = createClient(config.database_url);
  const s3 = new S3Client({
    credentials: {
      accessKeyId: config.s3_access_key_id,
      secretAccessKey: config.s3_secret_access_key,
    },
    endpoint: config.s3_endpoint,
    forcePathStyle: config.s3_force_path_style,
    region: config.s3_region,
  });

  const lockResult = await db.$queryRaw<[{ pg_try_advisory_lock: boolean }]>`
    SELECT pg_try_advisory_lock(hashtext(${`job:${JOB_NAME}`}))
  `;
  if (!lockResult[0]?.pg_try_advisory_lock) {
    logger.warn({ jobName: JOB_NAME }, 'Advisory lock not acquired, another instance running');
    return;
  }

  let jobRunId: bigint | undefined;
  try {
    const jobRun = await db.jobRun.create({
      data: { jobName: JOB_NAME, startedAt: new Date(), status: 'running' },
    });
    jobRunId = jobRun.id;

    const sampleLimit = sample != null ? sample : 10_000;
    const unembedded = await db.$queryRawUnsafe<
      { session_id: string; transcript_s3_key: string }[]
    >(
      `SELECT s.session_id, s.transcript_s3_key
       FROM sessions s
       WHERE s.transcript_s3_key IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM transcript_embeddings te WHERE te.session_id = s.session_id::uuid
         )
       LIMIT ${sampleLimit}`,
    );

    logger.info({ count: unembedded.length, jobName: JOB_NAME }, 'Sessions to embed');

    let totalChunks = 0;
    let totalSessions = 0;

    for (const row of unembedded) {
      try {
        const messages = await downloadAndParseTranscript(
          s3,
          config.s3_bucket,
          row.transcript_s3_key,
          logger,
        );
        if (messages === null) {
          continue;
        }

        const fullText = messages
          .map((m) => extractTextContent(m.content))
          .filter(Boolean)
          .join('\n\n');

        if (!fullText.trim()) {
          continue;
        }

        const chunks = chunkText(fullText);
        if (chunks.length === 0) {
          continue;
        }

        const allEmbeddings: number[][] = [];
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const batch = chunks.slice(i, i + BATCH_SIZE);
          const embeddings = await embedBatch(
            batch.map((c) => c.text),
            openaiApiKey,
            logger,
          );
          if (embeddings === null) {
            logger.warn({ sessionId: row.session_id }, 'Embedding batch failed, skipping session');
            break;
          }
          allEmbeddings.push(...embeddings);
          if (i + BATCH_SIZE < chunks.length) {
            await new Promise((r) => setTimeout(r, BATCH_SLEEP_MS));
          }
        }

        if (allEmbeddings.length !== chunks.length) {
          continue;
        }

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = allEmbeddings[i];
          if (!chunk || !embedding) {
            continue;
          }
          await db.$executeRawUnsafe(
            `INSERT INTO transcript_embeddings (session_id, chunk_index, content_text, embedding, model)
             VALUES ($1::uuid, $2, $3, $4::vector, $5)
             ON CONFLICT (session_id, chunk_index) DO NOTHING`,
            row.session_id,
            chunk.chunkIndex,
            chunk.text.slice(0, 50_000),
            vectorLiteral(embedding),
            EMBED_MODEL,
          );
        }

        totalChunks += chunks.length;
        totalSessions++;
      } catch (err) {
        logger.warn({ err, sessionId: row.session_id }, 'Failed to embed session, skipping');
      }
    }

    logger.info({ jobName: JOB_NAME, totalChunks, totalSessions }, 'Embedding complete');

    if (measure && totalSessions > 0) {
      await runMeasure(db, openaiApiKey, logger);
    }

    await db.jobRun.update({
      data: { finishedAt: new Date(), status: 'success' },
      where: { id: jobRunId },
    });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    logger.error({ err, jobName: JOB_NAME }, 'Embed-transcripts prototype failed');
    if (jobRunId !== undefined) {
      await db.jobRun
        .update({
          data: { errorText, finishedAt: new Date(), status: 'error' },
          where: { id: jobRunId },
        })
        .catch(() => {});
    }
    process.exit(1);
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext(${`job:${JOB_NAME}`}))`.catch(() => {});
  }
}

async function runMeasure(
  db: ReturnType<typeof createClient>,
  apiKey: string,
  logger: Logger,
): Promise<void> {
  logger.info('Running overlap measurement against keyword FTS');

  const results: {
    jaccardOverlap: number;
    keywordSessionIds: string[];
    query: string;
    semanticSessionIds: string[];
  }[] = [];

  for (const query of MEASURE_QUERIES) {
    const embeddings = await embedBatch([query], apiKey, logger);
    if (!embeddings || !embeddings[0]) {
      logger.warn({ query }, 'Could not embed query, skipping');
      continue;
    }

    const vecLiteral = vectorLiteral(embeddings[0]);

    const semanticRows = await db.$queryRaw<{ session_id: string }[]>`
      SELECT DISTINCT session_id::text
      FROM (
        SELECT session_id
        FROM transcript_embeddings
        ORDER BY embedding <=> ${vecLiteral}::vector
        LIMIT 200
      ) AS ranked
    `;

    const keywordRows = await db.$queryRaw<{ session_id: string }[]>`
      SELECT DISTINCT ti.session_id::text
      FROM transcript_index ti
      WHERE to_tsvector('english', ti.content_text) @@ plainto_tsquery('english', ${query})
      LIMIT 20
    `;

    const semanticIds = new Set<string>(
      semanticRows.map((r: { session_id: string }) => r.session_id),
    );
    const keywordIds = new Set<string>(
      keywordRows.map((r: { session_id: string }) => r.session_id),
    );
    const overlap = jaccard(semanticIds, keywordIds);

    results.push({
      jaccardOverlap: overlap,
      keywordSessionIds: [...keywordIds],
      query,
      semanticSessionIds: [...semanticIds],
    });

    logger.info({ jaccardOverlap: overlap.toFixed(3), query }, 'Measured');
  }

  const avgJaccard =
    results.length > 0 ? results.reduce((s, r) => s + r.jaccardOverlap, 0) / results.length : 0;

  const output = {
    avgJaccardOverlap: avgJaccard,
    model: EMBED_MODEL,
    queryCount: results.length,
    results,
  };

  const outPath = new URL('../../../../tasks/P7-007-overlap-results.json', import.meta.url);
  await Bun.write(outPath.pathname, JSON.stringify(output, null, 2));
  logger.info(
    { avgJaccard: avgJaccard.toFixed(3), path: outPath.pathname },
    'Overlap results written',
  );
}

if (import.meta.main) {
  await runEmbedTranscripts();
}
