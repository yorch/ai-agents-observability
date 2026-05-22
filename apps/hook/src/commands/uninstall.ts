import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FLUSHER_LABEL = 'com.claude-telemetry.flusher';
const SHIPPER_LABEL = 'com.claude-telemetry.shipper';

function uninstallDarwin(): number {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  const plists = [join(dir, `${FLUSHER_LABEL}.plist`), join(dir, `${SHIPPER_LABEL}.plist`)];

  for (const file of plists) {
    if (existsSync(file)) {
      Bun.spawnSync(['launchctl', 'unload', file]);
      rmSync(file, { force: true });
      process.stdout.write(`removed: ${file}\n`);
    }
  }

  process.stdout.write('\nServices uninstalled. Local data was not removed.\n');
  process.stdout.write('To remove local data: claude-telemetry purge-local\n');
  return 0;
}

function uninstallLinux(): number {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  const services = ['claude-telemetry-flusher.service', 'claude-telemetry-shipper.service'];

  for (const svc of services) {
    Bun.spawnSync(['systemctl', '--user', 'disable', '--now', svc]);
    const path = join(dir, svc);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      process.stdout.write(`removed: ${path}\n`);
    }
  }

  Bun.spawnSync(['systemctl', '--user', 'daemon-reload']);

  process.stdout.write('\nServices uninstalled. Local data was not removed.\n');
  process.stdout.write('To remove local data: claude-telemetry purge-local\n');
  return 0;
}

export function runUninstall(): number {
  if (process.platform === 'darwin') return uninstallDarwin();
  if (process.platform === 'linux') return uninstallLinux();

  process.stderr.write(`Unsupported platform: ${process.platform}\n`);
  return 1;
}
