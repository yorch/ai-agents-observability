import { join } from 'node:path';

import { homeDir } from './config-wire';

export const FLUSHER_LABEL = 'com.brnby.aiot.flusher';
export const SHIPPER_LABEL = 'com.brnby.aiot.shipper';

/** The launchd plists `aiot install` writes in resident mode (macOS). */
export function launchdPlists(): string[] {
  const dir = join(homeDir(), 'Library', 'LaunchAgents');
  return [join(dir, `${FLUSHER_LABEL}.plist`), join(dir, `${SHIPPER_LABEL}.plist`)];
}

/** The systemd user units `aiot install` writes in resident mode (Linux). */
export function systemdUnits(): string[] {
  const dir = join(homeDir(), '.config', 'systemd', 'user');
  return [join(dir, 'aiot-flusher.service'), join(dir, 'aiot-shipper.service')];
}

/** Service files for this platform, whether or not anything loaded them. */
export function residentServiceFiles(): string[] {
  if (process.platform === 'darwin') {
    return launchdPlists();
  }
  if (process.platform === 'linux') {
    return systemdUnits();
  }
  return [];
}
