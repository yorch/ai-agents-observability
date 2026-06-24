import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const webhookEventsTotal = new Counter({
  help: 'Total webhook events by event type and processing status',
  labelNames: ['event', 'status'] as const,
  name: 'webhook_events_total',
  registers: [registry],
});

export const webhookProcessingDuration = new Histogram({
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  help: 'Webhook processing duration in milliseconds by event type',
  labelNames: ['event'] as const,
  name: 'webhook_processing_duration_ms',
  registers: [registry],
});

export function recordReceived(event: string): void {
  webhookEventsTotal.inc({ event, status: 'received' });
}

export function recordProcessed(event: string, ms: number): void {
  webhookEventsTotal.inc({ event, status: 'processed' });
  webhookProcessingDuration.observe({ event }, ms);
}

export function recordFailed(event: string): void {
  webhookEventsTotal.inc({ event, status: 'failed' });
}

export type DeliveryCounts = { failed: number; processed: number; received: number };

/**
 * Per-event delivery counts for the admin health endpoint (GET /admin/health),
 * derived from the same prom-client counter that `/metrics` exposes (so the two
 * never drift). The full time series — including latency — is on `/metrics`.
 */
export async function getMetrics(): Promise<Record<string, DeliveryCounts>> {
  const metric = await webhookEventsTotal.get();
  const out: Record<string, DeliveryCounts> = {};
  for (const v of metric.values) {
    const event = String(v.labels.event ?? 'unknown');
    const status = String(v.labels.status ?? '');
    let bucket = out[event];
    if (!bucket) {
      bucket = { failed: 0, processed: 0, received: 0 };
      out[event] = bucket;
    }
    if (status === 'received' || status === 'processed' || status === 'failed') {
      bucket[status] = v.value;
    }
  }
  return out;
}
