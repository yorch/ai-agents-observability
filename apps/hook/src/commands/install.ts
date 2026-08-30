import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { type HookAdapter, selectAdapter } from '../adapters';

const FLUSHER_LABEL = 'com.brnby.aiot.flusher';
const SHIPPER_LABEL = 'com.brnby.aiot.shipper';

/** Spawn function — injectable so tests don't actually invoke launchctl/systemd. */
type SpawnFn = (cmd: readonly string[]) => { exitCode: number };

function defaultSpawn(cmd: readonly string[]): { exitCode: number } {
  try {
    return Bun.spawnSync(cmd as string[]);
  } catch {
    // ENOENT (command not found) or EACCES — translate to a clean exit code so
    // runInstall can report it consistently instead of throwing a stack trace.
    return { exitCode: 127 };
  }
}

interface InstallOptions {
  /** Write service files even when running from the Bun runtime, not the compiled binary. */
  force: boolean;
  /** Load/enable the services after writing their files (default: true). */
  start: boolean;
}

function parseArgs(args: readonly string[]): InstallOptions {
  const opts: InstallOptions = { force: false, start: true };
  for (const a of args) {
    if (a === '--start') {
      opts.start = true;
    } else if (a === '--no-start') {
      opts.start = false;
    } else if (a === '--force') {
      opts.force = true;
    } else if (a.startsWith('--')) {
      // --agent is consumed by cli.ts before we get here; surface anything else
      // so typos like --nostart don't silently fall back to the default.
      process.stderr.write(`Warning: ignoring unknown install flag: ${a}\n`);
    }
  }
  return opts;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function launchdPlist(label: string, bin: string, subcommand: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(bin)}</string>
    <string>${xmlEscape(subcommand)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/${xmlEscape(label)}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${xmlEscape(label)}.log</string>
</dict>
</plist>
`;
}

function systemdUnit(bin: string, subcommand: string, description: string): string {
  // Quote the binary path so systemd handles paths with spaces correctly.
  const quotedBin = bin.includes(' ') ? `"${bin}"` : bin;
  return `[Unit]
Description=${description}
After=network.target

[Service]
ExecStart=${quotedBin} ${subcommand}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function printHookSnippet(bin: string, adapter: HookAdapter): void {
  const cfg = adapter.installConfig();
  process.stdout.write(`${cfg.settingsHint}\n\n`);
  process.stdout.write(`${cfg.renderSnippet(bin)}\n`);
}

function resolvedBinaryPath(): string {
  // The guard in runInstall already refuses uncompiled without --force and
  // prints the explanatory message there, so no warning is needed here.
  return process.execPath;
}

/** True when process.execPath is the compiled aiot binary. */
function isCompiledBinary(): boolean {
  return basename(process.execPath).startsWith('aiot');
}

function installDarwin(
  bin: string,
  adapter: HookAdapter,
  opts: InstallOptions,
  spawn: SpawnFn,
  homeDir: string,
): number {
  const dir = join(homeDir, 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });

  const flusherPath = join(dir, `${FLUSHER_LABEL}.plist`);
  const shipperPath = join(dir, `${SHIPPER_LABEL}.plist`);

  // Unload existing services before overwriting so an upgrade restarts cleanly.
  for (const path of [flusherPath, shipperPath]) {
    if (existsSync(path)) {
      const r = spawn(['launchctl', 'unload', path]);
      if (r.exitCode !== 0) {
        process.stderr.write(
          `Warning: launchctl unload exited ${r.exitCode} for ${path} — continuing\n`,
        );
      }
    }
  }

  writeFileSync(flusherPath, launchdPlist(FLUSHER_LABEL, bin, 'flusher'), {
    encoding: 'utf8',
    mode: 0o644,
  });
  writeFileSync(shipperPath, launchdPlist(SHIPPER_LABEL, bin, 'shipper'), {
    encoding: 'utf8',
    mode: 0o644,
  });

  process.stdout.write(`wrote: ${flusherPath}\n`);
  process.stdout.write(`wrote: ${shipperPath}\n\n`);

  if (opts.start) {
    let startFailed = false;
    for (const path of [flusherPath, shipperPath]) {
      const r = spawn(['launchctl', 'load', path]);
      if (r.exitCode !== 0) {
        startFailed = true;
        process.stderr.write(
          `Error: launchctl load exited ${r.exitCode} for ${path}\n` +
            `  run manually: launchctl load ${path}\n`,
        );
      }
    }
    if (startFailed) {
      process.stderr.write('Service files were written but one or more services failed to load.\n');
      printHookSnippet(bin, adapter);
      return 1;
    }
    process.stdout.write('Services loaded.\n\n');
  } else {
    process.stdout.write('Load services:\n');
    process.stdout.write(`  launchctl load ${flusherPath}\n`);
    process.stdout.write(`  launchctl load ${shipperPath}\n\n`);
  }

  printHookSnippet(bin, adapter);
  return 0;
}

function installLinux(
  bin: string,
  adapter: HookAdapter,
  opts: InstallOptions,
  spawn: SpawnFn,
  homeDir: string,
): number {
  const dir = join(homeDir, '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });

  const flusherPath = join(dir, 'aiot-flusher.service');
  const shipperPath = join(dir, 'aiot-shipper.service');
  const services = ['aiot-flusher', 'aiot-shipper'];

  // Disable existing services before overwriting so an upgrade restarts cleanly.
  for (const svc of services) {
    if (existsSync(join(dir, `${svc}.service`))) {
      const r = spawn(['systemctl', '--user', 'disable', '--now', svc]);
      if (r.exitCode !== 0) {
        process.stderr.write(
          `Warning: systemctl disable --now exited ${r.exitCode} for ${svc} — continuing\n`,
        );
      }
    }
  }

  writeFileSync(flusherPath, systemdUnit(bin, 'flusher', 'aiot flusher'), {
    encoding: 'utf8',
    mode: 0o644,
  });
  writeFileSync(shipperPath, systemdUnit(bin, 'shipper', 'aiot shipper'), {
    encoding: 'utf8',
    mode: 0o644,
  });

  process.stdout.write(`wrote: ${flusherPath}\n`);
  process.stdout.write(`wrote: ${shipperPath}\n\n`);

  if (opts.start) {
    const reload = spawn(['systemctl', '--user', 'daemon-reload']);
    if (reload.exitCode !== 0) {
      process.stderr.write(
        `Error: systemctl daemon-reload exited ${reload.exitCode}\n` +
          '  Service files were written but systemd was not reloaded.\n',
      );
      printHookSnippet(bin, adapter);
      return 1;
    }
    let startFailed = false;
    for (const svc of services) {
      const r = spawn(['systemctl', '--user', 'enable', '--now', svc]);
      if (r.exitCode !== 0) {
        startFailed = true;
        process.stderr.write(
          `Error: systemctl enable --now exited ${r.exitCode} for ${svc}\n` +
            `  run manually: systemctl --user enable --now ${svc}\n`,
        );
      }
    }
    if (startFailed) {
      process.stderr.write(
        'Service files were written but one or more services failed to start.\n',
      );
      printHookSnippet(bin, adapter);
      return 1;
    }
    process.stdout.write('Services enabled and started.\n\n');
  } else {
    process.stdout.write('Enable and start services:\n');
    process.stdout.write('  systemctl --user daemon-reload\n');
    process.stdout.write('  systemctl --user enable --now aiot-flusher\n');
    process.stdout.write('  systemctl --user enable --now aiot-shipper\n\n');
  }

  printHookSnippet(bin, adapter);
  return 0;
}

export function runInstall(
  args: readonly string[] = [],
  adapter: HookAdapter = selectAdapter(),
  spawn: SpawnFn = defaultSpawn,
  homeDir: string = homedir(),
): number {
  const opts = parseArgs(args);

  // Refuse to write service files pointing at the Bun runtime unless --force
  // is passed — they would fail to start and silently leave the user with no
  // telemetry collection.
  if (!isCompiledBinary() && !opts.force) {
    process.stderr.write(
      'Refusing to install: process.execPath is the Bun runtime, not the\n' +
        `compiled aiot binary (got: ${process.execPath}).\n` +
        'The generated service files would fail to start.\n\n' +
        'Build the binary first:\n' +
        '  bun run --cwd apps/hook build\n' +
        'then run: ./apps/hook/dist/aiot install\n\n' +
        'Or pass --force to write the files anyway.\n',
    );
    return 1;
  }

  const bin = resolvedBinaryPath();

  if (process.platform === 'darwin') {
    return installDarwin(bin, adapter, opts, spawn, homeDir);
  }
  if (process.platform === 'linux') {
    return installLinux(bin, adapter, opts, spawn, homeDir);
  }

  process.stderr.write(`Unsupported platform: ${process.platform}. Manual setup required.\n\n`);
  printHookSnippet(bin, adapter);
  return 1;
}
