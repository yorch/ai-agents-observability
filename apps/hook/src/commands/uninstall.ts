import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS } from '../adapters';

const FLUSHER_LABEL = 'com.brnby.aiot.flusher';
const SHIPPER_LABEL = 'com.brnby.aiot.shipper';

/** Remove aiot's hook config from every adapter that supports removal. */
function removeAgentHooks(): void {
  let removedAny = false;
  for (const adapter of Object.values(ADAPTERS)) {
    const cfg = adapter.installConfig();
    if (!cfg.remove) {
      continue;
    }
    try {
      if (cfg.remove()) {
        process.stdout.write(`removed hooks: ${cfg.agentName}\n`);
        removedAny = true;
      }
    } catch (err) {
      process.stderr.write(
        `Warning: failed to remove hooks for ${cfg.agentName}: ${(err as Error).message}\n`,
      );
    }
  }
  if (removedAny) {
    process.stdout.write('\n');
  }
}

function uninstallDarwin(): number {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const plists = [join(dir, `${FLUSHER_LABEL}.plist`), join(dir, `${SHIPPER_LABEL}.plist`)];

  for (const file of plists) {
    if (existsSync(file)) {
      const result = Bun.spawnSync(['launchctl', 'unload', file]);
      if (result.exitCode !== 0) {
        process.stderr.write(
          `Warning: launchctl unload exited ${result.exitCode} for ${file} — service may still be running\n`,
        );
      }
      rmSync(file, { force: true });
      process.stdout.write(`removed: ${file}\n`);
    }
  }

  removeAgentHooks();
  process.stdout.write('\nServices uninstalled. Local data was not removed.\n');
  process.stdout.write('To remove local data: aiot purge-local\n');
  return 0;
}

function uninstallLinux(): number {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  const services = ['aiot-flusher.service', 'aiot-shipper.service'];

  let anyRemoved = false;
  for (const svc of services) {
    const path = join(dir, svc);
    if (existsSync(path)) {
      const result = Bun.spawnSync(['systemctl', '--user', 'disable', '--now', svc]);
      if (result.exitCode !== 0) {
        process.stderr.write(
          `Warning: systemctl disable --now exited ${result.exitCode} for ${svc} — service may still be running\n`,
        );
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

  removeAgentHooks();
  process.stdout.write('\nServices uninstalled. Local data was not removed.\n');
  process.stdout.write('To remove local data: aiot purge-local\n');
  return 0;
}

export function runUninstall(): number {
  if (process.platform === 'darwin') {
    return uninstallDarwin();
  }
  if (process.platform === 'linux') {
    return uninstallLinux();
  }

  process.stderr.write(`Unsupported platform: ${process.platform}\n`);
  return 1;
}
