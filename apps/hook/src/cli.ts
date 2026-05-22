import { runLogin } from './commands/login';
import { runPause } from './commands/pause';
import { runPurge } from './commands/purge';
import { runResume } from './commands/resume';
import { runInstall } from './commands/install';
import { runStatus } from './commands/status';
import { runUninstall } from './commands/uninstall';
import { runFlusher } from './flusher';
import { runHook } from './hook-entry';
import { log } from './lib/log';
import { isHookKind } from './lib/payload';
import { runShipper } from './shipper';

const VERSION = '0.1.0';

const HELP = `claude-telemetry v${VERSION}

Usage: claude-telemetry <command> [options]

Commands:
  login         Authenticate with the observability server (device-code flow)
  status        Show auth status, queue depth, and service state
  pause         Pause telemetry collection (writes a marker file)
  resume        Resume telemetry collection (removes the marker)
  purge-local   Remove all local data (queue, logs, identity) — use --yes to confirm
  install       Write launchd/systemd service files and print the hook snippet
  uninstall     Remove service files (does not remove local data)

  hook <kind>   Run a hook entrypoint (reads JSON from stdin)
                kinds: session-start, pre-tool-use, post-tool-use, stop,
                       user-prompt-submit, pre-compact, subagent-stop, notification
  flusher       Drain the SQLite queue and POST batches to /v1/events (long-running)
  shipper       Watch for transcript files and upload them to /v1/transcripts (long-running)

Options:
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
    if (!kind || !isHookKind(kind)) {
      log('warn', 'hook.invalid_kind', { kind: kind ?? null });
      return 0;
    }
    await runHook(kind, { quiet });
    return 0;
  }

  if (cmd === 'flusher') {
    await runFlusher();
    return 0;
  }

  if (cmd === 'shipper') {
    await runShipper();
    return 0;
  }

  if (cmd === 'login') {
    return runLogin();
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
    return runInstall();
  }

  if (cmd === 'uninstall') {
    return runUninstall();
  }

  process.stderr.write(`Unknown command: ${cmd}\nRun \`claude-telemetry --help\` for usage.\n`);
  return 1;
}

// Exit 1 on unexpected crashes so launchd/systemd supervisors restart the
// process. Hook invocations always return 0 explicitly inside main().
const exitCode = await main().catch(() => 1);
process.exit(exitCode);
