// Alerting thresholds shared between apps/web (render-time anomaly banners,
// org-queries.getAnomalies) and apps/ingest (the scheduled evaluate-alerts job,
// P9-001). Single source of truth so the dashboard and the alert engine never
// drift apart. apps/ingest cannot import from apps/web, so these live in the
// shared schemas package.

export type AlertRuleType =
  | 'spend_spike'
  | 'high_error_rate'
  | 'unknown_model_surge'
  | 'budget_threshold';

export type AlertSeverity = 'warn' | 'critical';

// Spend-spike: compare the recent window's spend to the prior baseline window's
// daily stddev. Fire above WARN sigma, escalate to critical above CRITICAL sigma.
export const SPEND_SPIKE_WINDOW_DAYS = 7;
export const SPEND_SPIKE_BASELINE_DAYS = 14;
export const SPEND_SPIKE_WARN_SIGMA = 2;
export const SPEND_SPIKE_CRITICAL_SIGMA = 3;

// High-error-rate: tool errors / tool calls over the recent window, only once a
// minimum call volume is reached (avoids noise on tiny samples).
export const ERROR_RATE_WARN = 0.1;
export const ERROR_RATE_CRITICAL = 0.25;
export const ERROR_RATE_MIN_CALLS = 100;

// Unknown-model surge: events that priced at $0 despite real token usage (a model
// missing from the price table). Fire when the recent count exceeds this default
// (overridable per-rule via params.threshold).
export const UNKNOWN_MODEL_SURGE_DEFAULT = 50;
export const UNKNOWN_MODEL_WINDOW_HOURS = 24;
