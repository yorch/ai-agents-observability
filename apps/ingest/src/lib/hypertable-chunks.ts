import { Prisma, type PrismaClient } from '@ai-agents-observability/db';

/**
 * Writing to the `events` hypertable, one chunk at a time.
 *
 * `events` compresses after 7 days (`packages/db/sql/migrations/0001_init.sql`),
 * so any job that rewrites a stored column has to deal with compressed chunks.
 * Rather than rely on DML-over-compressed-data, a chunk is decompressed, updated,
 * and recompressed — and only recompressed **if it was compressed**, so a chunk
 * the policy has not reached yet is not compressed early as a side effect.
 *
 * This lived inline in `jobs/reprice-events.ts` first. It moved here when
 * `jobs/compute-cost-attribution.ts` needed the identical dance: the details that
 * make it work (the `::text` casts, recompressing only what was compressed,
 * scoping the write by time range rather than `tableoid`) are the kind that get
 * dropped when a second copy is typed out from memory.
 */

/** The subset of the client these helpers need. */
export type ChunkDb = {
  $queryRaw: PrismaClient['$queryRaw'];
};

export type EventChunk = {
  chunkName: string;
  chunkSchema: string;
  isCompressed: boolean;
  rangeEnd: Date;
  rangeStart: Date;
};

type ChunkRow = {
  chunk_name: string;
  chunk_schema: string;
  is_compressed: boolean;
  range_end: Date;
  range_start: Date;
};

/**
 * Every chunk of the `events` hypertable, oldest first.
 *
 * Pass `since` to skip chunks that end before it — a windowed job walks four or
 * five chunks instead of the whole retention period.
 */
export async function listEventChunks(db: ChunkDb, since?: Date): Promise<EventChunk[]> {
  const sinceClause = since ? Prisma.sql`AND range_end > ${since}` : Prisma.sql``;
  const rows = await db.$queryRaw<ChunkRow[]>(Prisma.sql`
    SELECT chunk_schema, chunk_name, is_compressed, range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'events'
      ${sinceClause}
    ORDER BY range_start
  `);
  return rows.map((r) => ({
    chunkName: r.chunk_name,
    chunkSchema: r.chunk_schema,
    isCompressed: r.is_compressed,
    rangeEnd: r.range_end,
    rangeStart: r.range_start,
  }));
}

/**
 * Run `fn` with the chunk decompressed, then restore its prior state.
 *
 * Chunk identifiers are quoted with `format('%I.%I', …)` **in-database**, so they
 * never round-trip through string interpolation here. The `::text` casts on the
 * arguments are load-bearing: without them Postgres cannot infer a bare
 * parameter's type inside `format()` and rejects the statement with 42P18
 * "could not determine data type of parameter $1". The `::text` on the *result*
 * is load-bearing too — `decompress_chunk` returns `regclass`, which the Prisma
 * driver cannot decode (UnsupportedNativeDataType).
 *
 * Recompression runs in `finally`, so a failed write still leaves the chunk as
 * it was found.
 */
export async function withDecompressedChunk<T>(
  db: ChunkDb,
  chunk: EventChunk,
  fn: () => Promise<T>,
): Promise<T> {
  const target = Prisma.sql`
    format('%I.%I', ${chunk.chunkSchema}::text, ${chunk.chunkName}::text)::regclass
  `;
  if (!chunk.isCompressed) {
    return fn();
  }
  await db.$queryRaw(Prisma.sql`SELECT decompress_chunk(${target})::text`);
  try {
    return await fn();
  } finally {
    await db.$queryRaw(Prisma.sql`SELECT compress_chunk(${target})::text`);
  }
}
