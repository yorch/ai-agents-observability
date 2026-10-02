// For in-process tests of code that probes the service manager (`aiot status` runs
// `systemctl --user is-active` / `launchctl list`). Stubs Bun.spawnSync so the REAL
// service manager is never reached (the preload refuses it anyway) and records what
// was asked, so a test can still assert that the probe happened. Any other command is
// an error: this fake is for the service manager and nothing else.

import { spyOn } from 'bun:test';

export type FakeServiceManager = {
  /** Every argv the code under test tried to run. */
  calls: string[][];
  restore(): void;
};

/** Every unit reports "not active" (systemctl prints `inactive`, exits 3; launchctl exits 113). */
export function fakeServiceManager(): FakeServiceManager {
  const calls: string[][] = [];
  const spy = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: string[]) => {
    if (cmd[0] !== 'systemctl' && cmd[0] !== 'launchctl') {
      throw new Error(`fakeServiceManager: unexpected spawn of ${JSON.stringify(cmd)}`);
    }
    calls.push(cmd);
    return {
      exitCode: cmd[0] === 'systemctl' ? 3 : 113,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from(cmd[0] === 'systemctl' ? 'inactive\n' : ''),
      success: false,
    };
  }) as unknown as typeof Bun.spawnSync);
  return { calls, restore: () => spy.mockRestore() };
}
