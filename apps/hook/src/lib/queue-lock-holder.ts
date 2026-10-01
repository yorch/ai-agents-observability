// Test fixture for queue-busy.test.ts — not shipped (nothing imports it).
// Holds the queue's write lock from a separate process for a fixed time: SQLite's
// busy handling blocks the calling thread, so contention can only be staged from
// another process.
import { Database } from 'bun:sqlite';

const [dbPath, holdMs] = process.argv.slice(2);
const db = new Database(dbPath ?? '');
db.exec('PRAGMA journal_mode = WAL;');
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\n');
await Bun.sleep(Number(holdMs));
db.exec('COMMIT');
db.close();
