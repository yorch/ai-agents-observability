import { Counter, collectDefaultMetrics, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const webhookEventsTotal = new Counter({
  help: 'Total webhook events by event type and processing status',
  labelNames: ['event', 'status'] as const,
  name: 'webhook_events_total',
  registers: [registry],
});

export function recordReceived(event: string): void {
  webhookEventsTotal.inc({ event, status: 'received' });
}

export function recordProcessed(event: string, _ms: number): void {
  webhookEventsTotal.inc({ event, status: 'processed' });
}

export function recordFailed(event: string): void {
  webhookEventsTotal.inc({ event, status: 'failed' });
}

// getMetrics is kept for the admin health endpoint (GET /admin/health).
// The per-event counters are now exposed via /metrics (Prometheus scrape target).
export function getMetrics(): Record<string, unknown> {
  return { note: 'Per-event counters are now available via /metrics (prom-client)' };
}
