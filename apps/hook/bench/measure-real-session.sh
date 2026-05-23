#!/usr/bin/env bash
# Measure real-session hook latency by wrapping each hook invocation with
# nanosecond timestamps. Install this as the hook binary in a test session,
# run Claude Code normally, then collect the timings.
#
# Usage:
#   1. Build the real binary:
#        bun run build   (from apps/hook/)
#   2. Export the path to the real binary:
#        export REAL_BINARY="$(pwd)/dist/claude-telemetry"
#   3. Set claude-telemetry.hookBinary in your settings.json to point to THIS
#      script instead of the real binary.
#   4. Run a Claude Code session normally. Use Claude Code for a few minutes.
#   5. When done, the timings are in /tmp/claude-hook-timings.tsv
#   6. Run this script with --report to print the summary:
#        bash measure-real-session.sh --report
#
# The settings.json snippet:
#   "claudeTelemetry.hookBinary": "/path/to/measure-real-session.sh"
#
# Or, if using the full claude-telemetry install path, temporarily symlink:
#   ln -sf /path/to/measure-real-session.sh ~/.local/bin/claude-telemetry

set -euo pipefail

TIMINGS_FILE="${CLAUDE_TELEMETRY_TIMINGS_FILE:-/tmp/claude-hook-timings.tsv}"
REAL_BINARY="${REAL_BINARY:-$(dirname "$0")/../dist/claude-telemetry}"

if [[ "${1:-}" == "--report" ]]; then
  if [[ ! -f "$TIMINGS_FILE" ]]; then
    echo "No timings file found at $TIMINGS_FILE" >&2
    exit 1
  fi
  echo "Hook latency report — $TIMINGS_FILE"
  echo ""
  echo "kind                 count    mean_ms    p50_ms    p90_ms    p99_ms    max_ms"
  echo "---                  -----    -------    ------    ------    ------    ------"
  # Use awk to compute per-kind stats from the TSV (kind\tduration_ns columns)
  awk -F'\t' '
    {
      kind=$1; ns=$2
      ms = ns / 1000000.0
      count[kind]++
      sum[kind] += ms
      vals[kind][count[kind]] = ms
    }
    END {
      for (kind in count) {
        n = count[kind]
        # sort vals[kind]
        for (i = 1; i <= n; i++) arr[i] = vals[kind][i]
        for (i = 1; i <= n; i++) for (j = i+1; j <= n; j++) {
          if (arr[i] > arr[j]) { t = arr[i]; arr[i] = arr[j]; arr[j] = t }
        }
        mean = sum[kind] / n
        p50 = arr[int(n * 0.50)]
        p90 = arr[int(n * 0.90)]
        p99 = arr[int(n * 0.99)]
        max = arr[n]
        printf "%-20s %5d %10.2f %9.2f %9.2f %9.2f %9.2f\n", kind, n, mean, p50, p90, p99, max
      }
    }
  ' "$TIMINGS_FILE"
  exit 0
fi

# --- Hook wrapper ---
# Record start time, invoke real binary, record end time, append to TSV.
KIND="${2:-hook}"
T_START=$(date +%s%N)
"$REAL_BINARY" "$@"
EXIT_CODE=$?
T_END=$(date +%s%N)
DURATION_NS=$(( T_END - T_START ))
echo -e "${KIND}\t${DURATION_NS}" >> "$TIMINGS_FILE"
exit $EXIT_CODE
