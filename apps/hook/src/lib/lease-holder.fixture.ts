// Test fixture, run as a REAL child process by lease.test.ts.
//   bun lease-holder.fixture.ts <queue.db> <role> <holdMs> [startAtEpochMs]
// Prints HELD (then holds the lease for holdMs) or BUSY, one line, then exits.
import { withLease } from './lease';
import { openQueueReader } from './queue-reader';

const [dbPath, role, holdMs, startAt] = process.argv.slice(2);
if (!dbPath || !role || !holdMs) {
  throw new Error('usage: lease-holder.fixture.ts <queue.db> <role> <holdMs> [startAt]');
}

const reader = openQueueReader(dbPath);
// Line every contender up on the same instant so they race for real.
while (startAt && Date.now() < Number(startAt)) {
  // spin
}
const result = await withLease(reader.db, role as 'drain', async () => {
  process.stdout.write(`HELD ${process.pid}\n`);
  await Bun.sleep(Number(holdMs));
});
if (!result.held) {
  process.stdout.write(`BUSY ${process.pid}\n`);
}
reader.close();
process.exit(0);
