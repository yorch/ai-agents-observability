#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHook } from '../src/hook-entry';

const ITERATIONS = 1000;
const BUDGET_MS_P99 = 10;

const tmpHome = mkdtempSync(join(tmpdir(), 'claude-telemetry-bench-'));
process.env.CLAUDE_TELEMETRY_HOME = tmpHome;

const payload = JSON.stringify({
  cwd: '/home/dev/project',
  hook_event_name: 'PreToolUse',
  session_id: '550e8400-e29b-41d4-a716-446655440000',
  tool_input: { command: 'ls -la' },
  tool_name: 'Bash',
});

// Stub stdin so the read is constant-time.
const payloadBytes = new TextEncoder().encode(payload);
Bun.stdin.stream = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(payloadBytes);
      controller.close();
    },
  });

const samples: number[] = [];

// Warmup — exclude from samples.
for (let i = 0; i < 50; i++) {
  await runHook('pre-tool-use', { quiet: true });
}

for (let i = 0; i < ITERATIONS; i++) {
  const start = performance.now();
  await runHook('pre-tool-use', { quiet: true });
  samples.push(performance.now() - start);
}

samples.sort((a, b) => a - b);
const p = (q: number): number =>
  samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0;
const mean = samples.reduce((s, v) => s + v, 0) / samples.length;

process.stdout.write(
  `hook bench: n=${ITERATIONS} mean=${mean.toFixed(2)}ms p50=${p(0.5).toFixed(2)}ms p95=${p(0.95).toFixed(2)}ms p99=${p(0.99).toFixed(2)}ms (budget p99 < ${BUDGET_MS_P99}ms)\n`,
);

rmSync(tmpHome, { force: true, recursive: true });

if (p(0.99) >= BUDGET_MS_P99) {
  process.stdout.write(
    `WARN: p99 exceeded ${BUDGET_MS_P99}ms — investigate before P1-028 sign-off.\n`,
  );
  process.exit(1);
}
