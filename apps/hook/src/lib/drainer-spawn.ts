import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { isCompiledBinary, resolvedBinaryPath } from './binary-path';
import { claimDrainerSpawn } from './lease';
import { log } from './log';
import { telemetryHome } from './paths';
import type { Queue } from './queue';

/**
 * What a drainer inherits from the agent's shell. An allowlist, deliberately, with
 * one rule for what goes on it: variables that say WHERE delivery goes must not
 * come from the agent's shell; variables that say WHO the user is to GitHub may.
 *
 * The hook runs inside whatever shell the agent was started from, and that shell
 * routinely carries variables meant for the project being worked on:
 * `INGEST_BASE_URL=http://localhost:4000` while hacking on this very repo would
 * redirect every session on the machine's telemetry, and `AIOT_QUEUE_MAX_EVENTS`
 * would change what the queue drops. Those, and every other `INGEST_*` / `AIOT_*`
 * value, stay out; the ingest URL comes from the config file.
 *
 * GitHub credentials are the opposite case. Enrichment (PR number, CI and review
 * state, login, team) asks `gh` — or, where `gh` is not installed, the REST API
 * with GITHUB_TOKEN / GH_TOKEN — on the USER's behalf. A drainer without them
 * resolves nothing, silently, in exactly the container setup the docs recommend.
 * So the GitHub auth and host variables (GITHUB_TOKEN, GH_TOKEN, GH_HOST,
 * GH_CONFIG_DIR, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN) and
 * the two a Linux desktop's keyring-backed `gh` login needs
 * (DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR) are passed. The trade-off, accepted:
 * a token exported in the agent's shell for another purpose changes whose GitHub
 * identity enrichment resolves for that drain.
 *
 * GH_HOST stays on the list although it is a host: with GH_ENTERPRISE_TOKEN /
 * GITHUB_ENTERPRISE_TOKEN also passed, `gh api user` sends that token to whatever
 * host the agent's shell names. Accepted: whoever controls the agent's environment
 * already controls the agent (and the shell it runs commands in); the variable is
 * only useful to someone enriching against a GitHub Enterprise host, and dropping it
 * silently disables exactly that.
 *
 * GITHUB_API_URL is deliberately NOT passed. It names the host a token is sent to,
 * and an env-supplied host is exactly what must not receive one: `gh` finds a GitHub
 * Enterprise host through GH_HOST and its own config, and the REST fallback talks to
 * https://api.github.com unless the remote's own host matches the configured base.
 *
 * Also passed: the locations the drainer needs to find its state and config (HOME,
 * AIOT_HOME, AIOT_CONFIG, XDG_CONFIG_HOME — these pick a FILE, they are not
 * values), PATH for `git`/`gh`, TMPDIR, the proxy and CA settings a corporate
 * network needs to reach ingest at all, and AIOT_TOKEN so a container that
 * authenticates through the environment still can.
 */
const ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'TMPDIR',
  'AIOT_CONFIG',
  'AIOT_TOKEN',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;

export function drainerEnv(env: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const out: Record<string, string> = { AIOT_HOME: home };
  for (const key of ENV_ALLOWLIST) {
    const value = env[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Start a detached `aiot drain`, if this install is on-demand and nobody else is
 * already draining. Never throws and never blocks: a spawn failure is logged and
 * swallowed, because the hook must exit 0 and stay fast.
 *
 * The child must outlive the hook, and the agent may kill the hook's process
 * group the moment it returns — so it gets its own session (`detached` is
 * setsid), stdio all on /dev/null (hosts like Gemini and Copilot wait on
 * inherited pipes; opencode's plugin inherits stderr into the TUI), and the
 * telemetry home as its cwd so it never pins the agent's worktree.
 */
export function maybeSpawnDrainer(
  queue: Pick<Queue, 'db'>,
  opts: { bypassHold?: boolean } = {},
): void {
  try {
    if (process.platform === 'win32' || !isCompiledBinary()) {
      return;
    }
    if (!claimDrainerSpawn(queue.db, Date.now(), opts)) {
      return;
    }
    const bin = resolvedBinaryPath();
    if (!existsSync(bin)) {
      log('warn', 'drain.spawn_missing_launcher', { bin });
      return;
    }
    const home = telemetryHome();
    const child = spawn(bin, ['drain'], {
      cwd: home,
      detached: true,
      env: drainerEnv(process.env, home),
      stdio: 'ignore',
    });
    child.on('error', (err) => log('warn', 'drain.spawn_failed', { message: err.message }));
    child.unref();
  } catch (err) {
    log('warn', 'drain.spawn_failed', { message: (err as Error).message });
  }
}
