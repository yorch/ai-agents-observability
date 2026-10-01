import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS, type HookAdapter, selectAdapter } from '../adapters';
import { isCompiledBinary, resolvedBinaryPath } from '../lib/binary-path';
import { type InstallMode, readMode, stopLeaseHolder, writeMode } from '../lib/lease';
import { queuePath } from '../lib/paths';
import { type CheckboxItem, checkboxPrompt, isInteractive } from '../lib/prompt';
import { openQueue } from '../lib/queue';
import { openQueueReader } from '../lib/queue-reader';

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
  /** With --no-auto, write service files even when running from the Bun runtime, not the compiled binary. Never enables hook wiring. */
  force: boolean;
  /**
   * resident: launchd/systemd services. on-demand: no services, a short-lived
   * drainer. null = no `--mode` given: keep whatever mode is recorded (resident
   * when none is), so re-running `aiot install` after an upgrade or to wire a newly
   * installed agent never turns an on-demand install back into services.
   */
  mode: InstallMode | null;
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
    mode: null,
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
    } else if (a === '--mode' || a.startsWith('--mode=')) {
      const value = a === '--mode' ? args[++i] : a.slice('--mode='.length);
      if (value !== 'resident' && value !== 'on-demand') {
        throw new Error(`--mode must be "resident" or "on-demand" (got: ${value ?? 'nothing'})`);
      }
      opts.mode = value;
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
  if (!isCompiledBinary(bin)) {
    // A snippet for the Bun runtime is `bun hook <kind>`: copy-pasteable and wrong.
    process.stdout.write(
      '\nManual agent setup snippets omitted: not running from the compiled aiot binary.\n',
    );
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

/**
 * Stop and delete the resident mode's service units, if any. Switching to
 * on-demand must not leave a daemon running beside the drainers.
 */
function removeServiceUnits(spawn: SpawnFn, homeDir: string): string[] {
  const removed: string[] = [];
  if (process.platform === 'darwin') {
    const dir = join(homeDir, 'Library', 'LaunchAgents');
    for (const label of [FLUSHER_LABEL, SHIPPER_LABEL]) {
      const path = join(dir, `${label}.plist`);
      if (existsSync(path)) {
        spawn(['launchctl', 'unload', path]);
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
  } else if (process.platform === 'linux') {
    const dir = join(homeDir, '.config', 'systemd', 'user');
    for (const svc of ['aiot-flusher', 'aiot-shipper']) {
      const path = join(dir, `${svc}.service`);
      if (existsSync(path)) {
        spawn(['systemctl', '--user', 'disable', '--now', svc]);
        rmSync(path, { force: true });
        removed.push(path);
      }
    }
    if (removed.length > 0) {
      spawn(['systemctl', '--user', 'daemon-reload']);
    }
  }
  return removed;
}

/** The mode already recorded in queue.db, without creating one: resident when none. */
function recordedMode(): InstallMode {
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
 * Persist the install mode in queue.db (where the hook reads it without extra
 * I/O) and stop whatever holds the delivery lease, so a drainer from the other
 * mode cannot keep running beside the new one. Throws if the queue cannot be
 * opened — callers record the mode BEFORE touching units or hooks, so a failure
 * leaves the previous install exactly as it was.
 */
async function recordMode(mode: InstallMode): Promise<void> {
  const queue = openQueue();
  try {
    writeMode(queue.db, mode);
    if (!(await stopLeaseHolder(queue.db))) {
      throw new Error('another process holds the delivery lease and is not an aiot process');
    }
  } finally {
    queue.close();
  }
}

async function installOnDemand(
  bin: string,
  opts: InstallOptions,
  spawn: SpawnFn,
  homeDir: string,
): Promise<number> {
  if (opts.dryRun) {
    process.stdout.write(
      '[dry-run] Would record mode on-demand and remove any resident service units\n',
    );
    process.stdout.write('[dry-run] Would write NO launchd/systemd units\n');
    const { undetected } = await autoWire(bin, opts);
    printUndetectedSnippets(bin, undetected);
    return 0;
  }

  // Mode first: if it cannot be recorded the resident daemons are still in place.
  // A brief overlap of a resident daemon and a drainer is harmless — they share
  // the delivery lease.
  await recordMode('on-demand');
  for (const path of removeServiceUnits(spawn, homeDir)) {
    process.stdout.write(`removed resident service: ${path}\n`);
  }

  process.stdout.write(
    'Mode: on-demand. No service is registered; after agent activity the hook starts a\n' +
      'short-lived drainer. No resident process runs between agent sessions (a drainer\n' +
      'can linger up to 120 s after the last hook).\n\n',
  );
  const { undetected } = await autoWire(bin, opts);
  printUndetectedSnippets(bin, undetected);
  return 0;
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
  // Injectable so tests can exercise the compiled-binary path; production always
  // uses process.execPath.
  exe: string = process.execPath,
): Promise<number> {
  // Anything that throws below used to escape to cli.ts, which turns it into a
  // bare exit 1 with no message — after hooks may already have been wired.
  try {
    return await install(args, spawn, homeDir, exe);
  } catch (err) {
    process.stderr.write(`Error: install failed: ${(err as Error).message}\n`);
    return 1;
  }
}

async function install(
  args: readonly string[],
  spawn: SpawnFn,
  homeDir: string,
  exe: string,
): Promise<number> {
  const opts = parseArgs(args);

  // Hook wiring (autoWire → every adapter's apply) writes `bin` into the agent's
  // config. From the Bun runtime that is `bun hook <kind>`, which no agent can
  // run and which the ownership predicate cannot tell apart from a user's own
  // command on re-install. So an uncompiled run never wires hooks, --force or
  // not. --force only lets service files through, and only together with
  // --no-auto.
  if (!isCompiledBinary(exe) && (!opts.force || !opts.noAuto)) {
    process.stderr.write(
      'Refusing to install: process.execPath is the Bun runtime, not the\n' +
        `compiled aiot binary (got: ${exe}).\n` +
        'Agent hooks written from here would run `bun hook <kind>` and fail,\n' +
        'and the service files would fail to start.\n\n' +
        'Build the binary first:\n' +
        '  bun run --cwd apps/hook build\n' +
        'then run: ./apps/hook/dist/aiot install\n\n' +
        'To write only the service files from the Bun runtime, pass\n' +
        '--force --no-auto (agent hooks are never wired from here).\n',
    );
    return 1;
  }

  const bin = resolvedBinaryPath(exe);
  const mode = opts.mode ?? recordedMode();

  if (mode === 'on-demand' && (process.platform === 'darwin' || process.platform === 'linux')) {
    return installOnDemand(bin, opts, spawn, homeDir);
  }
  // Recorded before any unit is written or hook wired, so a resident install over
  // an on-demand one stops hooks spawning drainers first.
  if (!opts.dryRun && (process.platform === 'darwin' || process.platform === 'linux')) {
    await recordMode('resident');
  }

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
