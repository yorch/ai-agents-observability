// Shared harness for the on-demand end-to-end tests. Everything here runs the
// COMPILED binary: under `bun test` process.execPath is `bun`, where `bun drain`
// silently does nothing and a spawn test would pass without testing anything.
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK_DIR = join(import.meta.dir, '..', '..');

export const SKIP_E2E = process.platform === 'win32';
export const TOKEN = 'cct_e2e_token';

let binDir: string | null = null;

/**
 * Build the compiled runtime and a launcher beside it, once per test run. With a
 * Rust toolchain the real launcher is built; without one an `exec` shim stands in
 * for it — the launcher is an execv and nothing else, so process identity (same
 * pid, execPath = aiot-runtime) is the same either way. The fallback is loud.
 */
export function buildBinary(): string {
  if (binDir) {
    return join(binDir, 'aiot');
  }
  const dir = mkdtempSync(join(tmpdir(), 'aiot-bin-'));
  const build = Bun.spawnSync(
    ['bun', 'build', 'src/cli.ts', '--compile', '--outfile', join(dir, 'aiot-runtime')],
    { cwd: HOOK_DIR, stderr: 'pipe', stdout: 'pipe' },
  );
  if (build.exitCode !== 0) {
    throw new Error(`compiling the aiot runtime failed:\n${build.stderr.toString()}`);
  }
  if (Bun.which('cargo')) {
    const cargo = Bun.spawnSync(
      [
        'cargo',
        'build',
        '--release',
        '--manifest-path',
        join(HOOK_DIR, 'launcher', 'Cargo.toml'),
        '--target-dir',
        join(dir, 'target'),
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    if (cargo.exitCode !== 0) {
      throw new Error(`building the Rust launcher failed:\n${cargo.stderr.toString()}`);
    }
    Bun.spawnSync(['cp', join(dir, 'target', 'release', 'aiot'), join(dir, 'aiot')]);
  } else {
    console.warn(
      '[e2e] cargo not found: using an `exec` shell shim in place of the Rust launcher. ' +
        'The runtime is the real compiled binary; the launcher path is not exercised.',
    );
    writeFileSync(join(dir, 'aiot'), '#!/bin/sh\nexec "$(dirname "$0")/aiot-runtime" "$@"\n');
    chmodSync(join(dir, 'aiot'), 0o755);
  }
  binDir = dir;
  return join(dir, 'aiot');
}

// ── Fake ingest ───────────────────────────────────────────────────────────────

export type IngestOptions = {
  /** Per-request delay on /v1/events, ms. */
  eventsDelayMs?: number;
  eventsStatus?: number;
  /** Per-chunk delay on /v1/transcripts, ms. */
  chunkDelayMs?: number;
  /** Delay on an UNCHUNKED transcript upload (what `aiot import` sends), ms. */
  unchunkedDelayMs?: number;
  /** Never answer /v1/events. */
  hang?: boolean;
};

type Assembly = { assembling: boolean; completed: number; bytes: number; expected: number };

export type FakeIngest = {
  url: string;
  opts: IngestOptions;
  /** Every event received, in arrival order. */
  events: Array<Record<string, unknown>>;
  eventRequests: number;
  /** Per session: finished transcript uploads and their total bytes. */
  transcripts: Map<string, Assembly>;
  /** Protocol breaches that would corrupt the real server's assembled blob. */
  violations: string[];
  stop(): void;
};

/**
 * A stand-in for ingest that keeps the two behaviours the delivery design leans
 * on: /v1/transcripts 404s until the session's events arrived (so ordering is
 * observable), and chunks must arrive as one sequential assembly — a restart at 0
 * or an unchunked upload mid-assembly is recorded as a violation, which is what
 * two interleaving shippers do to the real route.
 */
export function startIngest(opts: IngestOptions = {}): FakeIngest {
  const sessions = new Set<string>();
  const state: FakeIngest = {
    eventRequests: 0,
    events: [],
    opts,
    stop: () => server.stop(true),
    transcripts: new Map(),
    url: '',
    violations: [],
  };
  const server = Bun.serve({
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' });
      }
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      if (url.pathname === '/v1/events' && req.method === 'POST') {
        state.eventRequests++;
        const body = (await req.json()) as { events: Array<Record<string, unknown>> };
        if (opts.hang) {
          await new Promise(() => {});
        }
        if (opts.eventsDelayMs) {
          await Bun.sleep(opts.eventsDelayMs);
        }
        const status = opts.eventsStatus ?? 200;
        if (status >= 200 && status < 300) {
          for (const e of body.events) {
            state.events.push(e);
            sessions.add(String(e.session_id));
          }
          return Response.json({ accepted: body.events.length, deduped: 0, rejected: 0 });
        }
        return new Response('nope', { status });
      }
      const m = url.pathname.match(/^\/v1\/transcripts\/([^/]+)$/);
      if (m && req.method === 'POST') {
        const id = m[1] as string;
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (!sessions.has(id)) {
          return new Response('session not found', { status: 404 });
        }
        const a = state.transcripts.get(id) ?? {
          assembling: false,
          bytes: 0,
          completed: 0,
          expected: 0,
        };
        state.transcripts.set(id, a);
        const range = req.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range) {
          if (a.assembling) {
            state.violations.push(`${id}: unchunked upload during a chunked assembly`);
          }
          if (opts.unchunkedDelayMs) {
            await Bun.sleep(opts.unchunkedDelayMs);
          }
          a.completed++;
          a.bytes += bytes.byteLength;
          return Response.json({ ok: true });
        }
        const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
        if (start === 0) {
          if (a.assembling) {
            state.violations.push(`${id}: assembly restarted at 0 while another was in progress`);
          }
          a.assembling = true;
          a.expected = 0;
        }
        if (start !== a.expected) {
          state.violations.push(`${id}: chunk at ${start}, expected ${a.expected}`);
          return new Response('conflict', { status: 409 });
        }
        a.expected = end + 1;
        if (opts.chunkDelayMs) {
          await Bun.sleep(opts.chunkDelayMs);
        }
        if (end + 1 === total) {
          a.assembling = false;
          a.completed++;
          a.bytes += total;
          return Response.json({ ok: true });
        }
        return new Response('{}', { status: 202 });
      }
      return new Response('not found', { status: 404 });
    },
    port: 0,
  });
  state.url = `http://127.0.0.1:${server.port}`;
  return state;
}

// ── A developer machine ───────────────────────────────────────────────────────

export type Machine = {
  /** `aiot` launcher path. */
  aiot: string;
  home: string;
  aiotHome: string;
  configPath: string;
  ghLog: string;
  /** Environment of the "agent shell" the hook runs in. */
  env: Record<string, string>;
  setIngest(url: string): void;
  setGhPrNumber(n: number): void;
  /** While true every `gh` call fails, as it does offline or logged out. */
  setGhFailing(failing: boolean): void;
  login(): void;
  db<T>(fn: (db: Database) => T): T;
};

/** Fake `gh`: canned answers, every invocation logged so lookups can be counted. */
function writeFakeGh(dir: string, log: string, prFile: string, failFile: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/sh
echo "$*" >> "${log}"
[ -f "${failFile}" ] && exit 1
case "$1 $2" in
  "pr list") cat "${prFile}" ;;
  "pr view") echo '{"reviewDecision":"APPROVED","statusCheckRollup":[]}' ;;
  "api user") echo octocat ;;
  api\\ user/teams*) echo '[]' ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, 'gh'), 0o755);
}

export function makeMachine(): Machine {
  const home = mkdtempSync(join(tmpdir(), 'aiot-e2e-'));
  const aiotHome = join(home, '.aiot');
  const configPath = join(home, 'config.json');
  const ghDir = join(home, 'bin');
  const ghLog = join(home, 'gh.log');
  const prFile = join(home, 'pr.json');
  writeFileSync(ghLog, '');
  writeFileSync(prFile, '[{"number":42}]');
  const ghFailFile = join(home, 'gh.fail');
  writeFakeGh(ghDir, ghLog, prFile, ghFailFile);
  // No e2e may reach a real service manager: both fakes only log their arguments.
  for (const tool of ['systemctl', 'launchctl']) {
    writeFileSync(
      join(ghDir, tool),
      `#!/bin/sh\necho "${tool} $@" >> '${join(home, 'service-manager.log')}'\nexit 3\n`,
      { mode: 0o755 },
    );
  }
  mkdirSync(aiotHome, { mode: 0o700, recursive: true });
  const m: Machine = {
    aiot: buildBinary(),
    aiotHome,
    configPath,
    db: (fn) => {
      const db = new Database(join(aiotHome, 'queue.db'));
      // A drainer or daemon is usually writing; bun:sqlite's default is to fail at once.
      db.exec('PRAGMA busy_timeout = 5000;');
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },
    env: {
      AIOT_CONFIG: configPath,
      AIOT_HOME: aiotHome,
      HOME: home,
      PATH: `${ghDir}:${process.env.PATH ?? ''}`,
    },
    ghLog,
    home,
    login: () =>
      writeFileSync(
        join(aiotHome, 'identity.json'),
        JSON.stringify({ token: TOKEN, user_id_claim: 'octocat' }),
        { mode: 0o600 },
      ),
    setGhFailing: (failing) => {
      if (failing) {
        writeFileSync(ghFailFile, '1');
      } else {
        rmSync(ghFailFile, { force: true });
      }
    },
    setGhPrNumber: (n) => writeFileSync(prFile, JSON.stringify([{ number: n }])),
    setIngest: (url) => writeFileSync(configPath, JSON.stringify({ ingest_url: url })),
  };
  return m;
}

export function ghCalls(m: Machine, prefix: string): number {
  return readFileSync(m.ghLog, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith(prefix)).length;
}

export async function aiot(
  m: Machine,
  args: string[],
  opts: { env?: Record<string, string>; stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn([m.aiot, ...args], {
    env: { ...m.env, ...opts.env },
    stderr: 'pipe',
    stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : 'ignore',
    stdout: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, ms: Date.now() - started, stderr, stdout };
}

export async function until(cond: () => boolean, timeoutMs = 20_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(50);
  }
}

// ── Realistic agent payloads ──────────────────────────────────────────────────

export function newSessionId(): string {
  return crypto.randomUUID();
}

function randomWords(chars: number): string {
  const out: string[] = [];
  for (let n = 0; n < chars; n += 65_536) {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.min(65_536, chars - n)));
    out.push(String.fromCharCode(...bytes.map((b) => (b < 40 ? 32 : 97 + (b % 26)))));
  }
  return out.join('');
}

/** Claude Code transcript lines in the shape the agent writes, with real usage + model ids. */
export function writeTranscript(
  path: string,
  sessionId: string,
  cwd: string,
  turns: number,
  padKb = 0,
): void {
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    const ts = new Date(Date.UTC(2026, 8, 30, 10, 0, i)).toISOString();
    lines.push(
      JSON.stringify({
        cwd,
        message: { content: `question ${i}`, role: 'user' },
        sessionId,
        timestamp: ts,
        type: 'user',
        uuid: crypto.randomUUID(),
        version: '2.1.0',
      }),
      JSON.stringify({
        cwd,
        message: {
          content: [
            {
              // Random lowercase words: they compress poorly, so `padKb` really
              // produces a multi-chunk upload. (Random base64 would NOT — the
              // redactor treats a long high-entropy token as a secret and the
              // whole line collapses to a few hundred bytes.)
              text: padKb ? randomWords(padKb * 1024) : `answer ${i}`,
              type: 'text',
            },
          ],
          id: `msg_${i}`,
          model: 'claude-opus-4-5-20251101',
          role: 'assistant',
          usage: {
            cache_creation_input_tokens: 300,
            cache_read_input_tokens: 12_000,
            input_tokens: 1500,
            output_tokens: 420,
          },
        },
        sessionId,
        timestamp: ts,
        type: 'assistant',
        uuid: crypto.randomUUID(),
        version: '2.1.0',
      }),
    );
  }
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
}

export function hookPayload(
  event: 'Stop' | 'SessionStart' | 'SessionEnd' | 'PreToolUse',
  sessionId: string,
  transcriptPath: string,
  cwd: string,
): string {
  return JSON.stringify({
    cwd,
    hook_event_name: event,
    session_id: sessionId,
    transcript_path: transcriptPath,
    ...(event === 'Stop' ? { stop_hook_active: false } : {}),
    ...(event === 'SessionStart' ? { source: 'startup' } : {}),
    ...(event === 'SessionEnd' ? { reason: 'prompt_input_exit' } : {}),
    ...(event === 'PreToolUse'
      ? {
          tool_input: { command: 'ls -la' },
          tool_name: 'Bash',
          tool_use_id: 'toolu_01A09q90qw90lq917835lq9',
        }
      : {}),
  });
}

export const HOOK_KIND = {
  PreToolUse: 'pre-tool-use',
  SessionEnd: 'session-end',
  SessionStart: 'session-start',
  Stop: 'stop',
} as const;

/** A git work tree with a GitHub remote, so the hook/flusher resolve real git context. */
export function makeRepo(m: Machine, branch = 'feature/drain'): string {
  const dir = join(m.home, 'work', 'widgets');
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_EMAIL: 'dev@example.com',
        GIT_AUTHOR_NAME: 'Dev',
        GIT_COMMITTER_EMAIL: 'dev@example.com',
        GIT_COMMITTER_NAME: 'Dev',
      },
    });
  git('init', '-q', '-b', branch);
  writeFileSync(join(dir, 'README.md'), '# widgets\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  return dir;
}
