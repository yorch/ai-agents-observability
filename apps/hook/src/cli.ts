import { runFlusher } from './flusher';
import { runHook } from './hook-entry';
import { log } from './lib/log';
import { isHookKind } from './lib/payload';
import { runShipper } from './shipper';

const VERSION = '0.1.0';

const HELP = `claude-telemetry v${VERSION}

Usage: claude-telemetry <command> [options]

Commands:
  hook <kind>   Run a hook entrypoint (reads JSON from stdin)
                 kinds: session-start, pre-tool-use, post-tool-use, stop,
                        user-prompt-submit, pre-compact, subagent-stop, notification
  flusher       Drain the SQLite queue and POST batches to /v1/events (long-running)
  shipper       Watch for transcript files and upload them to /v1/transcripts (long-running)
  login         Authenticate with the observability server
  status        Show current authentication status
  pause         Pause telemetry collection
  resume        Resume telemetry collection
  purge         Remove local queue and cached transcripts
  install       Install as a Claude Code hook

Options:
  --quiet        Suppress non-fatal output (errors still logged to file)
  -V, --version  Show version
  -h, --help     Show help`;

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
      // Hook context: never crash. Log the misuse for diagnosis, exit 0.
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

  process.stderr.write(`Command not yet implemented: ${cmd}\n`);
  return 1;
}

const exitCode = await main().catch(() => 0);
process.exit(exitCode);
