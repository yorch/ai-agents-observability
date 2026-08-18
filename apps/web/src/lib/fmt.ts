/** Null-tolerant `fmtDuration`, for latency columns that may have no sample. */
export function fmtDurationOrDash(ms: number | null): string {
  return ms === null ? '\u2014' : fmtDuration(ms);
}

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

/* Dates pin locale AND timezone (en-US, UTC): a bare toLocaleString renders in
   the server's zone on the SSR pass and the browser's on any client render, so
   the same timestamp could paint two ways. UTC matches how schedules and jobs
   are configured.

   Formatters are constructed once at module level — toLocaleString with an
   options bag builds and discards an Intl.DateTimeFormat per call, which adds
   up when a 50-row table formats every cell on every force-dynamic render. */

const DATE = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

const DATE_TIME = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  hour: '2-digit',
  hour12: false,
  minute: '2-digit',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
});

const DAY_SHORT = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

export function fmtDate(d: Date | null): string {
  return d ? DATE.format(d) : '\u2014';
}

/** Date + time, e.g. "Jan 5, 2026, 14:32". UTC — pair with a zone hint where ambiguity matters. */
export function fmtDateTime(d: Date | null): string {
  return d ? DATE_TIME.format(d) : '\u2014';
}

/** Short axis/row label, e.g. "Jan 5". UTC, like every date in the app. */
export function fmtDayShort(d: Date): string {
  return DAY_SHORT.format(d);
}

/** Wall-clock seconds \u2192 "45s" / "5m 12s" / "1h 5m". For session and PR durations. */
export function fmtDurationSec(seconds: number | null): string {
  if (seconds === null) {
    return '\u2014';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  if (m < 60) {
    return `${m}m ${seconds % 60}s`;
  }
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Hours \u2192 "18.0h" below a day, then "2.3d". For time-to-merge style stats. */
export function fmtHoursShort(hours: number | null): string {
  if (hours == null) {
    return '\u2014';
  }
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  }
  return `${(hours / 24).toFixed(1)}d`;
}

/** Compact token count: 950 \u2192 "950", 12 400 \u2192 "12.4k", 3.4e6 \u2192 "3.4M", 1.2e9 \u2192 "1.2B". */
export function fmtTokens(n: number | bigint): string {
  const v = Number(n);
  if (v >= 1_000_000_000) {
    return `${(v / 1_000_000_000).toFixed(1)}B`;
  }
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(1)}M`;
  }
  if (v >= 1_000) {
    return `${(v / 1_000).toFixed(1)}k`;
  }
  return `${v}`;
}

/** Per-session / per-event USD, three decimals \u2014 sub-cent costs are common.
    Aggregates use `fmtUsd` (2dp); the same quantity must not change shape
    between the list and the detail page. */
export function fmtUsdSession(n: number): string {
  return `$${n.toFixed(3)}`;
}
