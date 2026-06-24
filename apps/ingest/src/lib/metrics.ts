import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

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

// A model absent from the price table bills $0 despite real token usage. This
// counter makes that visible on the ops dashboard rather than only in logs, so
// an unpriced (e.g. newly released, or non-Anthropic) model is caught quickly.
// Intentionally unlabelled: the model string is client-supplied and unbounded,
// so using it as a label risks cardinality blowup. The model names are recorded
// in the accompanying warn log for triage.
export const unknownModelEventsTotal = new Counter({
  help: 'Events whose model was absent from the price table (billed $0)',
  name: 'unknown_model_events_total',
  registers: [registry],
});

// Cost reconciliation (P8-006). Client-computed cost vs vendor-billed cost for the
// previous calendar month, per agent. Labelled by agent_type (a small bounded set).
export const costReconciliationDeltaUsd = new Gauge({
  help: 'Client-computed minus vendor-billed cost (USD) for the reconciled month',
  labelNames: ['agent_type'],
  name: 'cost_reconciliation_delta_usd',
  registers: [registry],
});

export const costReconciliationDriftRatio = new Gauge({
  help: 'Absolute drift ratio |client - vendor| / vendor for the reconciled month',
  labelNames: ['agent_type'],
  name: 'cost_reconciliation_drift_ratio',
  registers: [registry],
});

export const costReconciliationThresholdExceededTotal = new Counter({
  help: 'Reconciliation runs where drift exceeded the configured threshold',
  labelNames: ['agent_type'],
  name: 'cost_reconciliation_threshold_exceeded_total',
  registers: [registry],
});
