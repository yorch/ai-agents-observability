import { isBlockingNotification, type NotificationKind } from '@ai-agents-observability/schemas';

// Human response latency = how long the agent waited at a blocking notification
// (permission / idle / elicitation) before the next event in the session. Gaps
// longer than this are treated as the human stepping away (lunch, overnight),
// not active response time, and are capped so they don't dominate the mean.
export const MAX_RESPONSE_GAP_MS = 60 * 60 * 1000; // 1 hour

// One row per notification event that has a following event, with the gap to it.
// Produced by a LEAD() window query over the events firehose (see
// compute-effectiveness). Only blocking notifications are counted toward latency.
export type NotificationGapRow = {
  gap_ms: number;
  notification_kind: string | null;
  session_id: string;
};

export type ResponseLatencyAgg = { sampleCount: number; totalMs: number };

/**
 * Aggregate per-session human response latency from notification→next-event gaps.
 * Counts only blocking notifications, ignores negative/non-finite gaps, and caps
 * each gap at MAX_RESPONSE_GAP_MS. Pure (no I/O) so it is unit-testable.
 */
export function aggregateResponseLatency(
  rows: NotificationGapRow[],
): Map<string, ResponseLatencyAgg> {
  const out = new Map<string, ResponseLatencyAgg>();
  for (const row of rows) {
    if (
      !row.notification_kind ||
      !isBlockingNotification(row.notification_kind as NotificationKind)
    ) {
      continue;
    }
    if (!Number.isFinite(row.gap_ms) || row.gap_ms < 0) {
      continue;
    }
    const capped = Math.min(row.gap_ms, MAX_RESPONSE_GAP_MS);
    const cur = out.get(row.session_id) ?? { sampleCount: 0, totalMs: 0 };
    cur.sampleCount += 1;
    cur.totalMs += capped;
    out.set(row.session_id, cur);
  }
  return out;
}
