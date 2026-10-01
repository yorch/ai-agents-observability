// Test fixture, run as a REAL child process by lease.test.ts.
//   bun lease-stress.fixture.ts <queue.db> <role> <iterations> <startAtEpochMs>
// Takes the role's lease over and over. Inside each hold it bumps a shared counter
// for every kind the role covers and records a violation if anyone else is already
// inside — i.e. if mutual exclusion failed. Prints how many holds it got.
import { withLease } from './lease';
import { openQueueReader } from './queue-reader';

const [dbPath, role, iterations, startAt] = process.argv.slice(2);
if (!dbPath || !role || !iterations || !startAt) {
  throw new Error('usage: lease-stress.fixture.ts <queue.db> <role> <iterations> <startAt>');
}

const reader = openQueueReader(dbPath);
reader.db.exec(
  'CREATE TABLE IF NOT EXISTS crit (kind TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, viol INTEGER NOT NULL DEFAULT 0)',
);
reader.db.exec("INSERT OR IGNORE INTO crit (kind) VALUES ('events'), ('transcripts')");
while (Date.now() < Number(startAt)) {
  // line every contender up on the same instant
}

let held = 0;
for (let i = 0; i < Number(iterations); i++) {
  const result = await withLease(reader.db, role as 'drain', async (lease) => {
    // A drainer may hold only `events` (it merely WANTS transcripts): count what it holds.
    const kinds = [...lease.kinds];
    for (const kind of kinds) {
      reader.db.query('UPDATE crit SET n = n + 1 WHERE kind = ?').run(kind);
      const row = reader.db.query('SELECT n FROM crit WHERE kind = ?').get(kind) as { n: number };
      if (row.n !== 1) {
        reader.db.query('UPDATE crit SET viol = viol + 1 WHERE kind = ?').run(kind);
      }
    }
    await Bun.sleep(3);
    for (const kind of kinds) {
      reader.db.query('UPDATE crit SET n = n - 1 WHERE kind = ?').run(kind);
    }
  });
  if (result.held) {
    held += 1;
  }
  await Bun.sleep(Math.random() * 3);
}
process.stdout.write(`${role} held=${held}\n`);
reader.close();
