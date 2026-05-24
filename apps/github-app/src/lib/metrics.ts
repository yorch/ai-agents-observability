type Counter = { failed: number; processed: number; received: number };
type CircularBuffer = { buf: number[]; size: number; head: number };

const counters = new Map<string, Counter>();
const latencies = new Map<string, CircularBuffer>();

const WINDOW_SIZE = 1000;

function getCounter(event: string): Counter {
  let c = counters.get(event);
  if (!c) {
    c = { failed: 0, processed: 0, received: 0 };
    counters.set(event, c);
  }
  return c;
}

function recordLatency(event: string, ms: number): void {
  let buf = latencies.get(event);
  if (!buf) {
    buf = { buf: [], head: 0, size: WINDOW_SIZE };
    latencies.set(event, buf);
  }
  if (buf.buf.length < buf.size) {
    buf.buf.push(ms);
  } else {
    buf.buf[buf.head % buf.size] = ms;
    buf.head++;
  }
}

function p99(event: string): number | null {
  const buf = latencies.get(event);
  if (!buf || buf.buf.length === 0) {
    return null;
  }
  const sorted = [...buf.buf].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1] ?? null;
}

export function recordReceived(event: string): void {
  getCounter(event).received++;
}

export function recordProcessed(event: string, ms: number): void {
  getCounter(event).processed++;
  recordLatency(event, ms);
}

export function recordFailed(event: string): void {
  getCounter(event).failed++;
}

export function getMetrics(): Record<
  string,
  { failed: number; p99_ms: number | null; processed: number; received: number }
> {
  const result: Record<
    string,
    { failed: number; p99_ms: number | null; processed: number; received: number }
  > = {};
  for (const [event, c] of counters) {
    result[event] = { ...c, p99_ms: p99(event) };
  }
  return result;
}
