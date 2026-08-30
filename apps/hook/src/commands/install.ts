import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { ADAPTERS, type HookAdapter, selectAdapter } from '../adapters';
import { type CheckboxItem, checkboxPrompt, isInteractive } from '../lib/prompt';

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
  /** Explicit agent names to wire (--agent flag, repeatable). */
  agents: string[];
  /** Show what would be wired without modifying files. */
  dryRun: boolean;
  /** Write service files even when running from the Bun runtime, not the compiled binary. */
  force: boolean;
  /** Skip auto-wiring, print snippets only (legacy behavior). */
  noAuto: boolean;
  /** Load/enable the services after writing their files (default: true). */
  start: boolean;
  /** Wire all detected agents without prompting. */
  yes: boolean;
}

function parseArgs(args: readonly string[]): InstallOptions {
  const opts: InstallOptions = {
    agents: [],
    dryRun: false,
    force: false,
    noAuto: false,
    start: true,
    yes: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) {
      continue;
    }
    if (a === '--start') {
      opts.start = true;
    } else if (a === '--no-start') {
      opts.start = false;
    } else if (a === '--force') {
      opts.force = true;
    } else if (a === '--no-auto') {
      opts.noAuto = true;
    } else if (a === '--yes' || a === '-y') {
      opts.yes = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--agent') {
      // --agent is also consumed by cli.ts, but if it reaches here (e.g. multiple
      // --agent flags for selective wiring), collect them.
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        opts.agents.push(next);
        i++;
      }
    } else if (a.startsWith('--agent=')) {
      opts.agents.push(a.slice('--agent='.length));
    } else if (a.startsWith('--')) {
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

// ── Auto-wire: detect agents, prompt, apply hooks ─────────────────────────────

/** Agent name → adapter key in ADAPTERS. */
function adapterKeyFor(agentName: string): string | null {
  const normalized = agentName.toLowerCase().replaceAll('_', '-');
  return normalized in ADAPTERS ? normalized : null;
}

/** Detect all installed agents and return their adapter keys + display info. */
function detectAgents(): { key: string; label: string; detail: string }[] {
  const detected: { key: string; label: string; detail: string }[] = [];
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    const cfg = adapter.installConfig();
    if (cfg.detect?.()) {
      detected.push({
        detail: cfg.settingsHint.replace(/^Add (to|a|an) /, '').replace(/[:].*$/, ''),
        key,
        label: cfg.agentName,
      });
    }
  }
  return detected;
}

/**
 * Run the auto-wire flow: detect agents, prompt the user (or use --yes/--agent),
 * and apply hooks to the selected agents. Returns the list of agent keys that
 * were wired (or would be wired in dry-run mode).
 */
async function autoWire(
  bin: string,
  opts: InstallOptions,
): Promise<{ wired: string[]; undetected: string[] }> {
  // --no-auto: skip entirely, caller prints snippets.
  if (opts.noAuto) {
    return { undetected: Object.keys(ADAPTERS), wired: [] };
  }

  // --agent X: wire only the specified agents, no detection or prompt.
  if (opts.agents.length > 0) {
    const wired: string[] = [];
    for (const name of opts.agents) {
      const key = adapterKeyFor(name);
      if (!key) {
        process.stderr.write(`Unknown agent: ${name}\n`);
        process.stderr.write(`Available: ${Object.keys(ADAPTERS).join(', ')}\n`);
        continue;
      }
      const adapter = ADAPTERS[key];
      if (!adapter) {
        continue;
      }
      const cfg = adapter.installConfig();
      if (!cfg.apply) {
        process.stderr.write(`Agent ${cfg.agentName} does not support auto-wiring.\n`);
        process.stdout.write(`\n${cfg.settingsHint}\n\n${cfg.renderSnippet(bin)}\n`);
        continue;
      }
      if (opts.dryRun) {
        process.stdout.write(`[dry-run] Would wire ${cfg.agentName}\n`);
      } else {
        const result = cfg.apply(bin);
        if (result) {
          process.stdout.write(`Wired ${cfg.agentName}: ${result}\n`);
          wired.push(key);
        }
      }
    }
    return { undetected: [], wired };
  }

  // Detect installed agents.
  const detected = detectAgents();

  if (detected.length === 0) {
    // No agents detected — print snippets for all.
    return { undetected: Object.keys(ADAPTERS), wired: [] };
  }

  // Determine which agents to wire.
  let selectedKeys: string[] | null;

  if (opts.yes || !isInteractive()) {
    // --yes or non-interactive: wire all detected agents.
    selectedKeys = detected.map((d) => d.key);
  } else {
    // Interactive: show checkbox prompt.
    process.stdout.write('\nDetected agents:\n');
    const items: CheckboxItem[] = detected.map((d) => ({
      detail: d.detail,
      label: d.label,
      selected: true,
      value: d.key,
    }));
    process.stdout.write(
      '\nWire hooks into which agents? (Space to toggle, Enter to confirm, q to skip)\n',
    );
    selectedKeys = await checkboxPrompt(items);
    if (selectedKeys === null) {
      process.stdout.write('Skipped agent wiring.\n');
      return { undetected: Object.keys(ADAPTERS), wired: [] };
    }
  }

  // Apply hooks to selected agents.
  const wired: string[] = [];
  for (const key of selectedKeys) {
    const adapter = ADAPTERS[key];
    if (!adapter) {
      continue;
    }
    const cfg = adapter.installConfig();
    if (!cfg.apply) {
      continue;
    }
    if (opts.dryRun) {
      process.stdout.write(`[dry-run] Would wire ${cfg.agentName}\n`);
      wired.push(key);
      continue;
    }
    const result = cfg.apply(bin);
    if (result) {
      process.stdout.write(`Wired ${cfg.agentName}: ${result}\n`);
      wired.push(key);
    }
  }

  // Undetected agents: collect for snippet printing.
  const undetected = Object.keys(ADAPTERS).filter((k) => !detected.some((d) => d.key === k));

  return { undetected, wired };
}

/** Print snippets for agents that were not auto-wired. */
function printUndetectedSnippets(bin: string, keys: string[]): void {
  if (keys.length === 0) {
    return;
  }
  process.stdout.write('\nManual setup for undetected agents:\n');
  for (const key of keys) {
    const adapter = ADAPTERS[key];
    if (!adapter) {
      continue;
    }
    const cfg = adapter.installConfig();
    process.stdout.write(`\n${cfg.agentName}:\n`);
    process.stdout.write(`${cfg.settingsHint}\n\n`);
    process.stdout.write(`${cfg.renderSnippet(bin)}\n`);
  }
}

function resolvedBinaryPath(): string {
  // The guard in runInstall already refuses uncompiled without --force and
  // prints the explanatory message there, so no warning is needed here.
  //
  // When running via the Rust launcher, process.execPath is `aiot-runtime`
  // (the Bun-compiled binary). Services and hook snippets must point at the
  // launcher (`aiot`), not the runtime, so that macOS BTM attributes the
  // background activity to our signature rather than Bun's.
  //
  // Cross-compiled distribution binaries carry a target suffix
  // (`aiot-runtime-darwin-arm64`); the sibling launcher is
  // `aiot-darwin-arm64`, so we strip just `runtime` (keeping any target
  // suffix) rather than replacing the whole name.
  const exe = process.execPath;
  const name = basename(exe);
  if (name.startsWith('aiot-runtime')) {
    return exe.replace('aiot-runtime', 'aiot');
  }
  return exe;
}

/** True when process.execPath is the compiled aiot binary. */
function isCompiledBinary(): boolean {
  return basename(process.execPath).startsWith('aiot');
}

async function installDarwin(
  bin: string,
  opts: InstallOptions,
  spawn: SpawnFn,
  homeDir: string,
): Promise<number> {
  const dir = join(homeDir, 'Library', 'LaunchAgents');
  const flusherPath = join(dir, `${FLUSHER_LABEL}.plist`);
  const shipperPath = join(dir, `${SHIPPER_LABEL}.plist`);

  if (opts.dryRun) {
    process.stdout.write('[dry-run] Would write:\n');
    process.stdout.write(`  ${flusherPath}\n`);
    process.stdout.write(`  ${shipperPath}\n`);
    if (opts.start) {
      process.stdout.write('[dry-run] Would run: launchctl load for both services\n');
    }
    const { undetected } = await autoWire(bin, opts);
    printUndetectedSnippets(bin, undetected);
    return 0;
  }

  mkdirSync(dir, { recursive: true });

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
      const { undetected } = await autoWire(bin, opts);
      printUndetectedSnippets(bin, undetected);
      return 1;
    }
    process.stdout.write('Services loaded.\n\n');
  } else {
    process.stdout.write('Load services:\n');
    process.stdout.write(`  launchctl load ${flusherPath}\n`);
    process.stdout.write(`  launchctl load ${shipperPath}\n\n`);
  }

  const { undetected } = await autoWire(bin, opts);
  printUndetectedSnippets(bin, undetected);
  return 0;
}

async function installLinux(
  bin: string,
  opts: InstallOptions,
  spawn: SpawnFn,
  homeDir: string,
): Promise<number> {
  const dir = join(homeDir, '.config', 'systemd', 'user');
  const flusherPath = join(dir, 'aiot-flusher.service');
  const shipperPath = join(dir, 'aiot-shipper.service');
  const services = ['aiot-flusher', 'aiot-shipper'];

  if (opts.dryRun) {
    process.stdout.write('[dry-run] Would write:\n');
    process.stdout.write(`  ${flusherPath}\n`);
    process.stdout.write(`  ${shipperPath}\n`);
    if (opts.start) {
      process.stdout.write(
        '[dry-run] Would run: systemctl --user enable --now for both services\n',
      );
    }
    const { undetected } = await autoWire(bin, opts);
    printUndetectedSnippets(bin, undetected);
    return 0;
  }

  mkdirSync(dir, { recursive: true });

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
      const { undetected } = await autoWire(bin, opts);
      printUndetectedSnippets(bin, undetected);
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
      const { undetected } = await autoWire(bin, opts);
      printUndetectedSnippets(bin, undetected);
      return 1;
    }
    process.stdout.write('Services enabled and started.\n\n');
  } else {
    process.stdout.write('Enable and start services:\n');
    process.stdout.write('  systemctl --user daemon-reload\n');
    process.stdout.write('  systemctl --user enable --now aiot-flusher\n');
    process.stdout.write('  systemctl --user enable --now aiot-shipper\n\n');
  }

  const { undetected } = await autoWire(bin, opts);
  printUndetectedSnippets(bin, undetected);
  return 0;
}

export async function runInstall(
  args: readonly string[] = [],
  _adapter: HookAdapter = selectAdapter(),
  spawn: SpawnFn = defaultSpawn,
  homeDir: string = homedir(),
): Promise<number> {
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
    return installDarwin(bin, opts, spawn, homeDir);
  }
  if (process.platform === 'linux') {
    return installLinux(bin, opts, spawn, homeDir);
  }

  process.stderr.write(`Unsupported platform: ${process.platform}. Manual setup required.\n\n`);
  const { undetected } = await autoWire(bin, opts);
  printUndetectedSnippets(bin, undetected);
  return 1;
}
