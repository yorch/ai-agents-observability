import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  help: 'Total HTTP requests by method, route, status',
  labelNames: ['method', 'route', 'status'],
  name: 'http_requests_total',
  registers: [registry],
});

export const httpRequestDurationMs = new Histogram({
  buckets: [5, 10, 25, 50, 100, 200, 500, 1000, 2500],
  help: 'HTTP request duration in milliseconds',
  labelNames: ['method', 'route', 'status'],
  name: 'http_request_duration_ms',
  registers: [registry],
});

export const eventsIngestedTotal = new Counter({
  help: 'Total telemetry events ingested',
  labelNames: ['agent_type'],
  name: 'events_ingested_total',
  registers: [registry],
});

export const transcriptsStoredTotal = new Counter({
  help: 'Total transcripts stored to S3',
  name: 'transcripts_stored_total',
  registers: [registry],
});
