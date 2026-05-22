import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK_KINDS = [
  'session-start',
  'pre-tool-use',
  'post-tool-use',
  'stop',
  'user-prompt-submit',
  'pre-compact',
  'subagent-stop',
  'notification',
] as const;

const FLUSHER_LABEL = 'com.claude-telemetry.flusher';
const SHIPPER_LABEL = 'com.claude-telemetry.shipper';

function launchdPlist(label: string, bin: string, subcommand: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>${subcommand}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/${label}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/${label}.log</string>
</dict>
</plist>
`;
}

function systemdUnit(bin: string, subcommand: string, description: string): string {
  return `[Unit]
Description=${description}
After=network.target

[Service]
ExecStart=${bin} ${subcommand}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function printHookSnippet(bin: string): void {
  const hooks: Record<string, string> = {};
  for (const kind of HOOK_KINDS) {
    hooks[kind] = `${bin} hook ${kind}`;
  }
  process.stdout.write('Add to ~/.claude/settings.json:\n\n');
  process.stdout.write(`${JSON.stringify({ hooks }, null, 2)}\n`);
}

function installDarwin(bin: string): number {
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });

  const flusherPath = join(dir, `${FLUSHER_LABEL}.plist`);
  const shipperPath = join(dir, `${SHIPPER_LABEL}.plist`);

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
  process.stdout.write('Load services:\n');
  process.stdout.write(`  launchctl load ${flusherPath}\n`);
  process.stdout.write(`  launchctl load ${shipperPath}\n\n`);

  printHookSnippet(bin);
  return 0;
}

function installLinux(bin: string): number {
  const dir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(dir, { recursive: true });

  const flusherPath = join(dir, 'claude-telemetry-flusher.service');
  const shipperPath = join(dir, 'claude-telemetry-shipper.service');

  writeFileSync(flusherPath, systemdUnit(bin, 'flusher', 'claude-telemetry flusher'), {
    encoding: 'utf8',
    mode: 0o644,
  });
  writeFileSync(shipperPath, systemdUnit(bin, 'shipper', 'claude-telemetry shipper'), {
    encoding: 'utf8',
    mode: 0o644,
  });

  process.stdout.write(`wrote: ${flusherPath}\n`);
  process.stdout.write(`wrote: ${shipperPath}\n\n`);
  process.stdout.write('Enable and start services:\n');
  process.stdout.write('  systemctl --user daemon-reload\n');
  process.stdout.write('  systemctl --user enable --now claude-telemetry-flusher\n');
  process.stdout.write('  systemctl --user enable --now claude-telemetry-shipper\n\n');

  printHookSnippet(bin);
  return 0;
}

export function runInstall(): number {
  const bin = process.execPath;

  if (process.platform === 'darwin') {
    return installDarwin(bin);
  }
  if (process.platform === 'linux') {
    return installLinux(bin);
  }

  process.stderr.write(`Unsupported platform: ${process.platform}. Manual setup required.\n\n`);
  printHookSnippet(bin);
  return 1;
}
