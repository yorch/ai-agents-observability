import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // reprice-events.db.test.ts and compute-cost-attribution.db.test.ts share
    // one Postgres/Timescale `events` hypertable and must never run in the same
    // vitest worker pool as each other — concurrently they decompress/recompress
    // overlapping chunks and deadlock, or read each other's compressed-chunk
    // counts (tasks/P14-014-db-test-isolation.md). Splitting into two projects
    // keeps the ~30 non-DB files running at full parallelism while forcing the
    // two `*.db.test.ts` files into their own project with fileParallelism
    // disabled, so an explicitly enabled DB run can never reintroduce the race.
    projects: [
      {
        test: {
          exclude: ['**/node_modules/**', '**/.git/**', 'test/*.db.test.ts'],
          name: 'unit',
        },
      },
      {
        test: {
          fileParallelism: false,
          include: ['test/*.db.test.ts'],
          name: 'db',
        },
      },
    ],
  },
});
