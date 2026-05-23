#!/usr/bin/env bun
/**
 * Hook performance benchmark.
 *
 * Measures both warm-start (in-process, repeated invocations) and cold-start
 * (one spawned process per invocation, matching how Claude Code actually calls
 * the hook) across all four primary hook entry points.
 *
 * Usage:
 *   bun run bench                                    # full benchmark
 *   PERF_COLD_ONLY=1 bun run bench                  # cold-start only (CI mode)
 *   PERF_BINARY=/path/to/binary bun run bench       # explicit binary path
 *   PERF_NO_WRITE=1 bun run bench                   # skip writing results file
 *
 * Env vars:
 *   PERF_BINARY          Path to compiled binary (default: dist/claude-telemetry)
 *   PERF_WARM_ITERATIONS Warm iterations per kind (default: 1000)
 *   PERF_COLD_ITERATIONS Cold iterations per kind (default: 100)
 *   PERF_COLD_ONLY       Skip warm-start benchmark
 *   PERF_NO_WRITE        Skip writing results markdown
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHook } from '../src/hook-entry';
import type { HookKind } from '../src/lib/payload';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WARM_ITERATIONS = Number(process.env.PERF_WARM_ITERATIONS ?? 1000);
const COLD_ITERATIONS = Number(process.env.PERF_COLD_ITERATIONS ?? 100);
const COLD_ONLY = Boolean(process.env.PERF_COLD_ONLY);
const NO_WRITE = Boolean(process.env.PERF_NO_WRITE);

const WARM_P99_LIMIT_MS = 10;
const COLD_P99_LIMIT_MS = 15;

// ---------------------------------------------------------------------------
// Synthetic payloads — ~500 bytes each, representative of real hook events
// ---------------------------------------------------------------------------

const PAYLOADS: Record<HookKind, string> = {
  notification: JSON.stringify({
    cwd: '/home/dev/project/some-repo',
    hook_event_name: 'Notification',
    message: 'Claude Code is waiting for your input on a long-running operation',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
  }),
  'post-tool-use': JSON.stringify({
    cwd: '/home/dev/project/some-repo',
    duration_ms: 45,
    exit_code: 0,
    hook_event_name: 'PostToolUse',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
    tool_input: { command: 'cat src/index.ts' },
    tool_name: 'Bash',
    tool_response:
      'total 64\ndrwxr-xr-x  12 user group  384 May 22 14:30 .\ndrwxr-xr-x   5 user group  160 May 20 09:15 ..\n-rw-r--r--   1 user group 1234 May 22 10:00 index.ts\n-rw-r--r--   1 user group  892 May 21 11:22 types.ts',
    turn_number: 17,
  }),
  'pre-compact': JSON.stringify({
    cwd: '/home/dev/project/some-repo',
    hook_event_name: 'PreCompact',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
    turn_number: 40,
  }),
  'pre-tool-use': JSON.stringify({
    cwd: '/home/dev/project/some-repo/packages/backend',
    hook_event_name: 'PreToolUse',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
    tool_input: {
      command: 'ls -la /home/dev/project/some-repo/packages/backend/src',
      description: 'List source files in the backend package directory',
    },
    tool_name: 'Bash',
    turn_number: 17,
  }),
  'session-start': JSON.stringify({
    claude_code_version: '1.2.3',
    cwd: '/home/dev/project/some-repo/packages/backend',
    git_branch: 'feat/TICKET-9876-add-telemetry-pipeline',
    git_commit: 'abc1234567890abcdef1234567890abcdef123456',
    git_is_dirty: true,
    git_remote_url: 'git@github.com:example-org/example-repo.git',
    hook_event_name: 'SessionStart',
    hostname_hash: 'sha256:6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d4964',
    os: 'linux',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
  }),
  stop: JSON.stringify({
    cwd: '/home/dev/project/some-repo/packages/backend',
    end_reason: 'completed',
    hook_event_name: 'Stop',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
    // Non-existent path — writeShipMarker only writes a JSON marker file, not the transcript
    transcript_path: '/tmp/claude-bench-noop/550e8400-e29b-41d4-a716-446655440001.jsonl',
  }),
  'subagent-stop': JSON.stringify({
    cwd: '/home/dev/project/some-repo',
    hook_event_name: 'SubagentStop',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
    subagent_session_id: '660e8400-e29b-41d4-a716-446655440002',
  }),
  'user-prompt-submit': JSON.stringify({
    cwd: '/home/dev/project/some-repo',
    hook_event_name: 'UserPromptSubmit',
    session_id: '550e8400-e29b-41d4-a716-446655440001',
    turn_number: 5,
  }),
};

const BENCH_KINDS: HookKind[] = ['session-start', 'pre-tool-use', 'post-tool-use', 'stop'];

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

type Stats = { n: number; mean: number; p50: number; p90: number; p99: number; max: number };

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const pct = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return {
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    n: sorted.length,
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
  };
}

const fmt = (ms: number): string => `${ms.toFixed(2)}ms`;

// ---------------------------------------------------------------------------
// Warm-start benchmark (in-process)
// ---------------------------------------------------------------------------

async function warmBench(kind: HookKind, iterations: number): Promise<Stats> {
  const bytes = new TextEncoder().encode(PAYLOADS[kind]);
  // Replace the stdin stream factory so each runHook call sees a fresh stream
  // with the synthetic payload. Bun.stdin.stream() is called once per runHook.
  // biome-ignore lint/suspicious/noExplicitAny: patching Bun internal for bench
  (Bun.stdin as any).stream = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });

  // Warmup — prime SQLite connection, JIT paths, file descriptor cache.
  for (let i = 0; i < 50; i++) {
    await runHook(kind, { quiet: true });
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await runHook(kind, { quiet: true });
    samples.push(performance.now() - t0);
  }
  return computeStats(samples);
}

// ---------------------------------------------------------------------------
// Cold-start benchmark (spawn binary per invocation)
// ---------------------------------------------------------------------------

async function coldBench(
  binary: string,
  kind: HookKind,
  iterations: number,
  env: Record<string, string>,
): Promise<Stats> {
  const payloadBytes = new TextEncoder().encode(PAYLOADS[kind]);

  // Warmup — prime filesystem caches so first measured iteration is not an outlier.
  for (let i = 0; i < 10; i++) {
    const proc = Bun.spawn({
      cmd: [binary, 'hook', kind, '--quiet'],
      env,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    });
    proc.stdin.write(payloadBytes);
    proc.stdin.end();
    await proc.exited;
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const proc = Bun.spawn({
      cmd: [binary, 'hook', kind, '--quiet'],
      env,
      stderr: 'pipe',
      stdin: 'pipe',
      stdout: 'pipe',
    });
    proc.stdin.write(payloadBytes);
    proc.stdin.end();
    await proc.exited;
    samples.push(performance.now() - t0);
  }
  return computeStats(samples);
}

// ---------------------------------------------------------------------------
// Markdown result rendering
// ---------------------------------------------------------------------------

function mdTableHeader(): string {
  return [
    `| Hook kind            |     n |     mean |      p50 |      p90 |      p99 |      max | verdict |`,
    `| -------------------- | ----- | -------- | -------- | -------- | -------- | -------- | ------- |`,
  ].join('\n');
}

function mdTableRow(kind: string, s: Stats, limit: number): string {
  const verdict = s.p99 <= limit ? 'PASS' : 'FAIL';
  return `| ${kind.padEnd(20)} | ${String(s.n).padStart(5)} | ${fmt(s.mean).padStart(8)} | ${fmt(s.p50).padStart(8)} | ${fmt(s.p90).padStart(8)} | ${fmt(s.p99).padStart(8)} | ${fmt(s.max).padStart(8)} | ${verdict}    |`;
}

function buildMarkdown(
  warmResults: Map<HookKind, Stats> | null,
  coldResults: Map<HookKind, Stats> | null,
  meta: { date: string; sha: string; machine: string },
): string {
  const lines: string[] = [
    '# Hook Benchmark Results',
    '',
    `| | |`,
    `|---|---|`,
    `| Date | ${meta.date} |`,
    `| Git SHA | \`${meta.sha}\` |`,
    `| Machine | ${meta.machine} |`,
    `| Warm iterations | ${WARM_ITERATIONS} per kind |`,
    `| Cold iterations | ${COLD_ITERATIONS} per kind |`,
    '',
  ];

  if (warmResults) {
    lines.push(
      '## Warm-start (in-process)',
      '',
      `Budget: p99 < ${WARM_P99_LIMIT_MS}ms`,
      '',
      mdTableHeader(),
    );
    for (const kind of BENCH_KINDS) {
      const s = warmResults.get(kind);
      if (s) {
        lines.push(mdTableRow(kind, s, WARM_P99_LIMIT_MS));
      }
    }
    lines.push('');
  }

  if (coldResults) {
    lines.push(
      '## Cold-start (one spawned process per invocation)',
      '',
      `Budget: p99 < ${COLD_P99_LIMIT_MS}ms — this mirrors how Claude Code actually invokes the hook.`,
      '',
      mdTableHeader(),
    );
    for (const kind of BENCH_KINDS) {
      const s = coldResults.get(kind);
      if (s) {
        lines.push(mdTableRow(kind, s, COLD_P99_LIMIT_MS));
      }
    }
    lines.push('');
  }

  lines.push(
    '## Real-session measurements',
    '',
    'Run the wrapper script against a live Claude Code session to capture per-hook',
    'wall-clock latency as observed by the OS process scheduler:',
    '',
    '```bash',
    'bash apps/hook/bench/measure-real-session.sh',
    '```',
    '',
    'Append the output here after running.',
    '',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const tmpHome = mkdtempSync(join(tmpdir(), 'claude-telemetry-bench-'));
  process.env.CLAUDE_TELEMETRY_HOME = tmpHome;

  const benchDir = dirname(fileURLToPath(import.meta.url));
  const hookDir = resolve(benchDir, '..');
  const defaultBinary = join(hookDir, 'dist', 'claude-telemetry');
  const binaryPath = process.env.PERF_BINARY ?? defaultBinary;
  const hasBinary = existsSync(binaryPath);

  if (COLD_ONLY && !hasBinary) {
    process.stderr.write(
      `error: cold-start benchmark requires a compiled binary at ${binaryPath}\n` +
        `       run "bun run build" in apps/hook first, or set PERF_BINARY\n`,
    );
    rmSync(tmpHome, { force: true, recursive: true });
    return 1;
  }

  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: hookDir }).toString().trim();
  } catch {
    sha = `t${Date.now()}`;
  }

  const date = new Date().toISOString().slice(0, 10);
  const machine = `${process.platform} (${process.arch})`;

  process.stdout.write(`hook benchmark  ${date}  ${sha}  ${machine}\n`);
  process.stdout.write(
    `warm=${COLD_ONLY ? 'skip' : WARM_ITERATIONS}  cold=${hasBinary ? COLD_ITERATIONS : 'skip (no binary)'}\n\n`,
  );

  // --- Warm-start -----------------------------------------------------------
  const warmResults = new Map<HookKind, Stats>();

  if (!COLD_ONLY) {
    process.stdout.write(`warm-start (in-process)  budget p99 < ${WARM_P99_LIMIT_MS}ms\n`);
    process.stdout.write(
      `  ${'kind'.padEnd(20)} ${'mean'.padStart(8)} ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}\n`,
    );
    for (const kind of BENCH_KINDS) {
      const s = await warmBench(kind, WARM_ITERATIONS);
      warmResults.set(kind, s);
      const verdict = s.p99 <= WARM_P99_LIMIT_MS ? 'ok' : `OVER (>${WARM_P99_LIMIT_MS}ms)`;
      process.stdout.write(
        `  ${kind.padEnd(20)} ${fmt(s.mean).padStart(8)} ${fmt(s.p50).padStart(8)} ${fmt(s.p90).padStart(8)} ${fmt(s.p99).padStart(8)} ${fmt(s.max).padStart(8)}  ${verdict}\n`,
      );
    }
    process.stdout.write('\n');
  }

  // --- Cold-start -----------------------------------------------------------
  const coldResults = new Map<HookKind, Stats>();

  if (hasBinary) {
    // Pass the full environment so the spawned binary behaves like a real hook,
    // but override CLAUDE_TELEMETRY_HOME to the temp dir.
    const coldEnv: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    );
    coldEnv.CLAUDE_TELEMETRY_HOME = tmpHome;

    process.stdout.write(
      `cold-start (spawn-per-invocation)  binary=${binaryPath}  budget p99 < ${COLD_P99_LIMIT_MS}ms\n`,
    );
    process.stdout.write(
      `  ${'kind'.padEnd(20)} ${'mean'.padStart(8)} ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'p99'.padStart(8)} ${'max'.padStart(8)}\n`,
    );
    for (const kind of BENCH_KINDS) {
      const s = await coldBench(binaryPath, kind, COLD_ITERATIONS, coldEnv);
      coldResults.set(kind, s);
      const verdict = s.p99 <= COLD_P99_LIMIT_MS ? 'ok' : `OVER (>${COLD_P99_LIMIT_MS}ms)`;
      process.stdout.write(
        `  ${kind.padEnd(20)} ${fmt(s.mean).padStart(8)} ${fmt(s.p50).padStart(8)} ${fmt(s.p90).padStart(8)} ${fmt(s.p99).padStart(8)} ${fmt(s.max).padStart(8)}  ${verdict}\n`,
      );
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write(
      `cold-start skipped — binary not found at ${binaryPath}\n` +
        `  run "bun run build" in apps/hook to compile it\n\n`,
    );
  }

  // --- Write result markdown ------------------------------------------------
  if (!NO_WRITE) {
    const resultsDir = join(benchDir, 'results');
    mkdirSync(resultsDir, { recursive: true });
    const resultFile = join(resultsDir, `${date}-${sha}.md`);
    const md = buildMarkdown(COLD_ONLY ? null : warmResults, hasBinary ? coldResults : null, {
      date,
      machine,
      sha,
    });
    writeFileSync(resultFile, md);
    process.stdout.write(`results written → ${resultFile}\n`);
  }

  rmSync(tmpHome, { force: true, recursive: true });

  // --- Exit code ------------------------------------------------------------
  let failed = false;

  if (!COLD_ONLY) {
    for (const [kind, s] of warmResults) {
      if (s.p99 > WARM_P99_LIMIT_MS) {
        process.stderr.write(
          `FAIL warm-start ${kind}: p99=${fmt(s.p99)} exceeds ${WARM_P99_LIMIT_MS}ms budget\n`,
        );
        failed = true;
      }
    }
  }

  for (const [kind, s] of coldResults) {
    if (s.p99 > COLD_P99_LIMIT_MS) {
      process.stderr.write(
        `FAIL cold-start ${kind}: p99=${fmt(s.p99)} exceeds ${COLD_P99_LIMIT_MS}ms budget\n`,
      );
      failed = true;
    }
  }

  if (failed) {
    process.stderr.write(
      '\nnote: if cold-start failures are due to CI runner variability, set\n' +
        '      continue-on-error: true on the perf job and document the baseline.\n',
    );
  }

  return failed ? 1 : 0;
}

process.exit(await main());
