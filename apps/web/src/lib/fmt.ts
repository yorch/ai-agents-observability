export function fmtDuration(ms: number): string {
  if (ms >= 60_000) {
    return `${(ms / 60_000).toFixed(1)}m`;
  }
  if (ms >= 1_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

/** USD with two decimals, e.g. 4.2 → "$4.20". */
export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** A 0–1 ratio as a whole-number percent, e.g. 0.8 → "80%". */
export function fmtPct(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

/** Byte count in B/kB/MB/GB, e.g. 2048 → "2.0kB". Null or non-positive → "—". */
export function fmtBytes(n: number | null): string {
  if (n == null || n <= 0) {
    return '—';
  }
  if (n >= 1_000_000_000) {
    return `${(n / 1_000_000_000).toFixed(1)}GB`;
  }
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}MB`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}kB`;
  }
  return `${n}B`;
}

export function fmtDate(d: Date | null): string {
  if (!d) {
    return '\u2014';
  }
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
