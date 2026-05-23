# Hook performance benchmark

Measures the wall-clock latency added to a Claude Code session by the `claude-telemetry` hook binary. Two modes are measured:

| Mode | What it tests | Budget |
|------|--------------|--------|
| **Warm-start** | `runHook()` in-process, repeated invocations | p99 < 10ms |
| **Cold-start** | one spawned process per invocation (matches Claude Code behaviour) | p99 < 15ms |

Four hook entry points are tested: `session-start`, `pre-tool-use`, `post-tool-use`, `stop`.

## Quick start

```bash
# From the repo root
bun --filter '@ai-agents-observability/hook' bench
```

Or from `apps/hook/`:

```bash
# Warm + cold start (requires compiled binary)
bun run build          # compile the binary first
bun run bench

# Warm-start only (no binary needed)
bun run bench          # cold-start section is skipped if dist/ binary is absent

# Cold-start only (CI mode)
PERF_COLD_ONLY=1 PERF_BINARY=./dist/claude-telemetry bun run bench
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PERF_BINARY` | `dist/claude-telemetry` | Path to the compiled binary for cold-start |
| `PERF_WARM_ITERATIONS` | `1000` | Iterations per hook kind (warm-start) |
| `PERF_COLD_ITERATIONS` | `100` | Iterations per hook kind (cold-start) |
| `PERF_COLD_ONLY` | unset | Set to skip warm-start and run cold-start only |
| `PERF_NO_WRITE` | unset | Set to skip writing the results markdown file |

## Results files

Results are written to `results/<YYYY-MM-DD>-<git-sha>.md`. Commit these files so regressions are visible in git history. CI uploads them as job artifacts as well.

## Real-session measurements

The microbenchmark above uses synthetic payloads. To measure latency as Claude Code observes it during a real session, run the wrapper script:

```bash
bash bench/measure-real-session.sh
```

The script wraps each hook binary invocation with `date +%s%N` (nanosecond timestamps), runs a normal Claude Code session, and outputs a latency table when the session ends. Append the output to the relevant `results/` file.

## Interpreting results

- **p50 / p90** reflect typical performance. Most interactive tool calls see these numbers.
- **p99** is the gating metric. It must stay under the budget listed above. CI fails if it exceeds it.
- **max** is informational — single-sample spikes from OS scheduling are normal and not actionable unless they exceed 3–5× the p99.

## If CI is flaky

Cold-start timing is sensitive to CI runner load. If the `perf` workflow fails transiently:

1. Check whether the failure is consistent across multiple runs or a one-off spike.
2. If consistent, the hook logic needs profiling — open a task.
3. If it is runner noise, add `continue-on-error: true` to the perf job in `.github/workflows/perf.yml` and document the baseline in this README.

The current status of the CI gate is: **hard gate** (fails PR if p99 > 15ms). Update this line if it is downgraded to informational.
