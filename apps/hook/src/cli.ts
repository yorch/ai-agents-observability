const VERSION = '0.1.0';

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === '--version' || cmd === '-V') {
  console.log(VERSION);
  process.exit(0);
}

if (cmd === '--help' || cmd === '-h' || !cmd) {
  console.log(`claude-telemetry v${VERSION}

Usage: claude-telemetry <command>

Commands:
  login     Authenticate with the observability server
  status    Show current authentication status
  pause     Pause telemetry collection
  resume    Resume telemetry collection
  purge     Remove local queue and cached transcripts
  install   Install as a Claude Code hook

Options:
  -V, --version  Show version
  -h, --help     Show help`);
  process.exit(0);
}

console.error(`Unknown command: ${cmd}. Run claude-telemetry --help for usage.`);
process.exit(1);
