import pkg from '../package.json' with { type: 'json' };
import { type HookAdapter, selectAdapter } from './adapters';
import { runConfig } from './commands/config';
import { runDrain } from './commands/drain';
import { runImport } from './commands/import';
import { runInstall } from './commands/install';
import { runLogin } from './commands/login';
import { runPause } from './commands/pause';
import { runPurge } from './commands/purge';
import { runResume } from './commands/resume';
import { runStatus } from './commands/status';
import { runUninstall } from './commands/uninstall';
import { runFlusher } from './flusher';
import { runHook } from './hook-entry';
import { log } from './lib/log';
import { runShipper } from './shipper';

// Parse `--agent <name>` / `--agent=<name>`; defaults to claude-code.
function parseAgent(args: string[]): string | undefined {
  const eq = args.find((a) => a.startsWith('--agent='));
  if (eq) {
    return eq.slice('--agent='.length);
  }
  const idx = args.indexOf('--agent');
  if (idx >= 0 && args[idx + 1] && !args[idx + 1]?.startsWith('-')) {
    return args[idx + 1];
  }
  return undefined;
}

// package.json is the single source of truth (release automation bumps it); the JSON
// import is inlined into the `bun build --compile` binary.
const VERSION = pkg.version;

const HELP = `aiot v${VERSION}

Usage: aiot <command> [options]

Commands:
  login         Authenticate with the observability server (device-code flow)
  config        Persist or show web and ingest service URLs
  status        Show auth status, queue depth, and service state
  pause         Pause telemetry collection (writes a marker file)
  resume        Resume telemetry collection (removes the marker)
  purge-local   Remove all local data (queue, logs, identity) — use --yes to confirm
  import        Import historical Claude Code, Codex, OpenCode, Pi, or OMP sessions
  install       Wire hooks into detected agents and, in resident mode, write launchd/systemd service files
                flags: --no-start (don't load/enable), --force (allow uncompiled),
                       --yes (wire all detected agents without prompting),
                       --agent <name> (wire only this agent, repeatable),
                       --no-auto (skip auto-wiring, print snippets only),
                       --dry-run (show what would be wired without modifying files),
                       --mode resident|on-demand (resident: launchd/systemd services, default;
                         on-demand: no services, a short-lived drainer after agent activity)
  uninstall     Remove aiot hook config and any service files (does not remove local data)

  hook <kind>   Run a hook entrypoint (reads JSON from stdin)
                kinds: session-start, session-end, pre-tool-use, post-tool-use, stop,
                       user-prompt-submit, pre-compact, subagent-stop, notification
  drain         One delivery pass (events, then transcripts), then exit. Spawned by hooks in
                on-demand mode; --wait runs it in the foreground and exits non-zero if data remains
  flusher       Drain the SQLite queue and POST batches to /v1/events (long-running; resident mode)
  shipper       Watch for transcript files and upload them to /v1/transcripts (long-running; resident mode)

Options:
  --agent <name> Select the agent for install, hook, or historical import
  --quiet        Suppress non-fatal output (errors still logged to file)
  -V, --version  Show version
  -h, --help     Show help

Exit codes:
  0  Success
  1  Error (message written to stderr)`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const positional = args.filter((a) => !a.startsWith('-'));
  const cmd = positional[0];
  const adapter: HookAdapter = selectAdapter(parseAgent(args));

  if (args.includes('--version') || args.includes('-V')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (!cmd || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (cmd === 'hook') {
    const kind = positional[1];
    if (!kind || !adapter.isHookKind(kind)) {
      log('warn', 'hook.invalid_kind', { kind: kind ?? null });
      return 0;
    }
    await runHook(kind, { quiet }, adapter);
    return 0;
  }

  if (cmd === 'flusher') {
    await runFlusher();
    return 0;
  }

  if (cmd === 'drain') {
    return runDrain(args);
  }

  if (cmd === 'shipper') {
    await runShipper();
    return 0;
  }

  if (cmd === 'login') {
    return runLogin();
  }

  if (cmd === 'config' || cmd === 'configure') {
    return runConfig(positional);
  }

  if (cmd === 'status') {
    return runStatus();
  }

  if (cmd === 'pause') {
    return runPause();
  }

  if (cmd === 'resume') {
    return runResume();
  }

  if (cmd === 'purge-local' || cmd === 'purge') {
    return runPurge(args);
  }

  if (cmd === 'install') {
    // Filter out the command name and --quiet so parseArgs only sees
    // install-specific flags. --agent is passed through so runInstall can
    // collect multiple --agent flags for selective wiring.
    const installArgs = args.filter((a) => {
      if (a === cmd) {
        return false;
      }
      if (a === '--quiet') {
        return false;
      }
      return true;
    });
    return await runInstall(installArgs, adapter);
  }

  if (cmd === 'uninstall') {
    return runUninstall();
  }

  if (cmd === 'import') {
    return runImport(args);
  }

  process.stderr.write(`Unknown command: ${cmd}\nRun \`aiot --help\` for usage.\n`);
  return 1;
}

// Exit 1 on unexpected crashes so launchd/systemd supervisors restart the
// process. Hook invocations always return 0 explicitly inside main().
const exitCode = await main().catch(() => 1);
process.exit(exitCode);
