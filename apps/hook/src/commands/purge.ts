import { existsSync, rmSync } from 'node:fs';

import { logPath } from '../lib/log';
import {
  flusherStatePath,
  identityPath,
  pausedPath,
  queuePath,
  shipQueueDir,
  telemetryHome,
} from '../lib/paths';

const DEFAULT_API = 'http://localhost:3000';

export async function runPurge(args: string[]): Promise<number> {
  const yes = args.includes('--yes') || args.includes('-y');
  const privacyUrl = `${(process.env.CLAUDE_TELEMETRY_API ?? DEFAULT_API).replace(/\/$/, '')}/me/privacy`;

  if (!yes) {
    process.stdout.write(
      [
        'This will permanently delete all local telemetry data:',
        `  event queue:   ${queuePath()}`,
        `  ship queue:    ${shipQueueDir()}`,
        `  log file:      ${logPath()}`,
        `  identity file: ${identityPath()}`,
        '',
        'Data already uploaded to the server is NOT affected.',
        `Manage server-side data at: ${privacyUrl}`,
        '',
        'Run with --yes to confirm:',
        '  claude-telemetry purge-local --yes',
        '',
      ].join('\n'),
    );
    return 1;
  }

  process.stdout.write(`Note: server-side data is not removed. Manage it at: ${privacyUrl}\n\n`);

  const removed: string[] = [];
  const failed: string[] = [];

  const home = telemetryHome();

  function tryRemove(path: string, recursive = false): void {
    if (!existsSync(path)) {
      return;
    }
    // Guard recursive deletes: refuse to remove a directory that isn't clearly
    // under telemetryHome so a misconfigured CLAUDE_TELEMETRY_HOME can't wipe
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
  tryRemove(shipQueueDir(), true);
  tryRemove(logPath());
  tryRemove(identityPath());
  tryRemove(flusherStatePath());
  tryRemove(pausedPath());

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
