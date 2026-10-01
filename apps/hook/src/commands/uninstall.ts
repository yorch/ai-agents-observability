import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';

import { ADAPTERS } from '../adapters';
import { type InstallMode, readMode, stopLeaseHolderIfAny } from '../lib/lease';
import { queuePath } from '../lib/paths';
import { openQueueReader } from '../lib/queue-reader';
import { launchdPlists, systemdUnits } from '../lib/service-files';

/** The install mode recorded in queue.db; `resident` when there is none to read. */
function readInstallMode(): InstallMode {
  if (!existsSync(queuePath())) {
    return 'resident';
  }
  const reader = openQueueReader(queuePath());
  try {
    return readMode(reader.db);
  } finally {
    reader.close();
  }
}

/**
 * Remove aiot's hook config from every adapter that supports removal. Returns the
 * agents whose removal FAILED: "nothing was wired" and "could not look" are
 * different answers, and only the first may say there is nothing to do.
 */
function removeAgentHooks(): string[] {
  let removedAny = false;
  const failed: string[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    const cfg = adapter.installConfig();
    if (!cfg.remove) {
      continue;
    }
    try {
      const outcome = cfg.remove();
      if (outcome === 'removed') {
        process.stdout.write(`removed hooks: ${cfg.agentName}\n`);
        removedAny = true;
      } else if (outcome === 'failed') {
        // The reason is already on stderr.
        failed.push(cfg.agentName);
      }
    } catch (err) {
      process.stderr.write(
        `Warning: failed to remove hooks for ${cfg.agentName}: ${(err as Error).message}\n`,
      );
      failed.push(cfg.agentName);
    }
  }
  if (failed.length > 0) {
    process.stdout.write(
      `Could not remove aiot hooks from: ${failed.join(', ')} (see errors above)\n`,
    );
  } else if (!removedAny) {
    // Only the auto-wired agent configs are inspected: project-level settings and
    // pasted snippets are invisible here.
    process.stdout.write('No aiot hooks found in auto-wired agent configs.\n');
  }
  if (removedAny) {
    process.stdout.write('\n');
  }
  return failed;
}

/** Say what actually happened, which depends on whether service files existed. */
function reportDone(
  services: { removed: boolean; notStopped: string[] },
  priorMode: InstallMode,
): void {
  if (services.removed) {
    process.stdout.write(
      services.notStopped.length > 0
        ? `\nService files removed (could not stop the running service: ${services.notStopped.join(', ')}). Local data was not removed.\n`
        : '\nServices removed. Local data was not removed.\n',
    );
  } else {
    const why = priorMode === 'on-demand' ? ' (on-demand mode installs none)' : '';
    process.stdout.write(`\nNo services to remove${why}. Local data was not removed.\n`);
  }
  if (priorMode === 'on-demand') {
    process.stdout.write('Install mode reset to resident.\n');
  }
  process.stdout.write('To remove local data: aiot purge-local\n');
}

function uninstallDarwin(priorMode: InstallMode): number {
  let anyRemoved = false;
  const notStopped: string[] = [];
  for (const file of launchdPlists()) {
    if (existsSync(file)) {
      const result = Bun.spawnSync(['launchctl', 'unload', file]);
      if (result.exitCode !== 0) {
        process.stderr.write(
          `Warning: launchctl unload exited ${result.exitCode} for ${file} — service may still be running\n`,
        );
        notStopped.push(basename(file, '.plist'));
      }
      rmSync(file, { force: true });
      process.stdout.write(`removed: ${file}\n`);
      anyRemoved = true;
    }
  }

  const failedAgents = removeAgentHooks();
  reportDone({ notStopped, removed: anyRemoved }, priorMode);
  return failedAgents.length > 0 ? 1 : 0;
}

function uninstallLinux(priorMode: InstallMode): number {
  let anyRemoved = false;
  const notStopped: string[] = [];
  for (const path of systemdUnits()) {
    const svc = basename(path);
    if (existsSync(path)) {
      const result = Bun.spawnSync(['systemctl', '--user', 'disable', '--now', svc]);
      if (result.exitCode !== 0) {
        process.stderr.write(
          `Warning: systemctl disable --now exited ${result.exitCode} for ${svc} — service may still be running\n`,
        );
        notStopped.push(svc);
      }
      rmSync(path, { force: true });
      process.stdout.write(`removed: ${path}\n`);
      anyRemoved = true;
    }
  }

  if (anyRemoved) {
    const result = Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);
    if (result.exitCode !== 0) {
      process.stderr.write(`Warning: systemctl daemon-reload exited ${result.exitCode}\n`);
    }
  }

  const failedAgents = removeAgentHooks();
  reportDone({ notStopped, removed: anyRemoved }, priorMode);
  return failedAgents.length > 0 ? 1 : 0;
}

export async function runUninstall(): Promise<number> {
  let priorMode: InstallMode = 'resident';
  try {
    priorMode = readInstallMode();
  } catch {
    // Unreadable queue.db: stopLeaseHolderIfAny below reports it.
  }
  // Mode first: a hook the remover misses (a pasted snippet, project-level or
  // MDM-managed settings) must stop spawning drainers before the running one is
  // stopped, or it would start the next as soon as this one died. Then a running
  // drainer must not outlive the uninstall and keep shipping.
  try {
    if (!(await stopLeaseHolderIfAny({ resetMode: true }))) {
      process.stderr.write('Warning: a process that is not aiot holds the delivery lease\n');
    }
  } catch (err) {
    process.stderr.write(
      `Warning: could not stop the running drainer: ${(err as Error).message}\n`,
    );
  }
  if (process.platform === 'darwin') {
    return uninstallDarwin(priorMode);
  }
  if (process.platform === 'linux') {
    return uninstallLinux(priorMode);
  }

  process.stderr.write(`Unsupported platform: ${process.platform}\n`);
  return 1;
}
