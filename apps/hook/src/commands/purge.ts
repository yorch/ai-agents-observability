import { existsSync, rmSync } from 'node:fs';

import { getWebBaseUrl } from '../lib/config';
import { readMode, stopLeaseHolderIfAny, writeMode } from '../lib/lease';
import { logPath } from '../lib/log';
import {
  agentStateRoot,
  flusherStatePath,
  identityPath,
  pausedPath,
  queuePath,
  shipQueueDir,
  telemetryHome,
} from '../lib/paths';
import { openQueue } from '../lib/queue';
import { openQueueReader } from '../lib/queue-reader';
import { collatedDir } from '../lib/transcript-collate';

export async function runPurge(args: string[]): Promise<number> {
  const yes = args.includes('--yes') || args.includes('-y');
  const privacyUrl = `${getWebBaseUrl()}/me/settings/privacy`;

  if (!yes) {
    process.stdout.write(
      [
        'This will permanently delete all local telemetry data:',
        `  event queue:    ${queuePath()} (+ -wal/-shm)`,
        `  ship queue:     ${shipQueueDir()}`,
        `  log file:       ${logPath()}`,
        `  staged uploads: ${collatedDir()}`,
        `  agent state:    ${agentStateRoot()}`,
        `  identity file:  ${identityPath()}`,
        `  flusher state:  ${flusherStatePath()}`,
        `  pause marker:   ${pausedPath()}`,
        '',
        'Data already uploaded to the server is NOT affected.',
        `Manage server-side data at: ${privacyUrl}`,
        '',
        'Run with --yes to confirm:',
        '  aiot purge-local --yes',
        '',
      ].join('\n'),
    );
    return 1;
  }

  process.stdout.write(`Note: server-side data is not removed. Manage it at: ${privacyUrl}\n\n`);

  const removed: string[] = [];
  const failed: string[] = [];

  // A live drainer would keep shipping from — or recreate — the state removed
  // below. The install mode is the one thing worth carrying across a purge:
  // without it an on-demand install silently stops delivering.
  let priorMode: 'resident' | 'on-demand' = 'resident';
  try {
    if (existsSync(queuePath())) {
      const reader = openQueueReader(queuePath());
      try {
        priorMode = readMode(reader.db);
      } finally {
        reader.close();
      }
    }
    await stopLeaseHolderIfAny();
  } catch (err) {
    process.stderr.write(
      `Warning: could not stop the running drainer: ${(err as Error).message}\n`,
    );
  }

  const home = telemetryHome();

  function tryRemove(path: string, recursive = false): void {
    if (!existsSync(path)) {
      return;
    }
    // Guard recursive deletes: refuse to remove a directory that isn't clearly
    // under telemetryHome so a misconfigured AIOT_HOME can't wipe
    // unrelated directory trees.
    if (recursive && !path.startsWith(`${home}/`)) {
      process.stderr.write(`skipping ${path}: not within ${home}\n`);
      failed.push(path);
      return;
    }
    try {
      rmSync(path, { force: true, recursive });
      removed.push(path);
    } catch {
      failed.push(path);
    }
  }

  tryRemove(queuePath());
  // The queue runs in WAL mode, so recent event payloads live in these two
  // siblings until a checkpoint folds them into queue.db — and the flusher
  // keeps a connection open, so they routinely exist. Deleting only queue.db
  // left cwd paths, repo names and tool arguments on disk after "delete all
  // local telemetry data", and a stale -wal can be replayed into a fresh DB.
  tryRemove(`${queuePath()}-wal`);
  tryRemove(`${queuePath()}-shm`);
  tryRemove(shipQueueDir(), true);
  tryRemove(logPath());
  tryRemove(`${logPath()}.1`); // the rotated generation (lib/log.ts)
  tryRemove(identityPath());
  tryRemove(flusherStatePath());
  tryRemove(pausedPath());
  // Staged (unredacted) transcript collations, and every adapter's working state
  // — per-session cursors and token tallies. Removed by CONVENTION rather than by
  // naming agents, so a new adapter's state cannot be forgotten here.
  tryRemove(collatedDir(), true);
  tryRemove(agentStateRoot(), true);

  if (priorMode === 'on-demand') {
    try {
      const queue = openQueue();
      writeMode(queue.db, priorMode);
      queue.close();
      process.stdout.write(
        'kept: install mode (on-demand). The agent hooks are still wired, so they will queue and\n' +
          'deliver again once you run `aiot login` (the identity file was removed above).\n',
      );
    } catch (err) {
      failed.push(`install mode (${(err as Error).message})`);
    }
  }

  for (const p of removed) {
    process.stdout.write(`removed: ${p}\n`);
  }
  for (const p of failed) {
    process.stderr.write(`failed to remove: ${p}\n`);
  }

  if (removed.length === 0 && failed.length === 0) {
    process.stdout.write('Nothing to remove.\n');
  }

  return failed.length > 0 ? 1 : 0;
}
