import type { AlertSeverity } from '@ai-agents-observability/schemas';

// The notification payload (P9-002). TRUST GUARDRAIL (non-negotiable): this is
// AGGREGATE-ONLY. It must never carry a session id, user id, login handle, or any
// transcript excerpt — not in the body, subject, or any field. buildAlertPayload
// reads only the rule name, severity, fired_at, and the numeric aggregate `details`
// produced by P9-001 (which are themselves aggregate-only). The test asserts the
// serialized payload contains no individual-identifying keys.

export type AlertPayload = {
  description: string;
  firedAt: string;
  ruleName: string;
  severity: AlertSeverity;
  url: string;
};

type RuleLike = { name: string; ruleType: string };
type EventLike = { details: Record<string, unknown>; firedAt: Date; severity: AlertSeverity };

function num(details: Record<string, unknown>, key: string): number {
  const v = details[key];
  return typeof v === 'number' ? v : 0;
}

// Human-readable, aggregate-only description per rule type.
function describe(ruleType: string, details: Record<string, unknown>): string {
  switch (ruleType) {
    case 'spend_spike':
      return `Org spend spiked ${num(details, 'sigma').toFixed(1)}σ above the ${num(details, 'windowDays')}-day baseline ($${num(details, 'currentCost').toFixed(2)} vs $${num(details, 'avgCost').toFixed(2)}/period avg).`;
    case 'high_error_rate':
      return `Tool error rate is ${(num(details, 'errorRate') * 100).toFixed(1)}% (${num(details, 'errors')} errors / ${num(details, 'calls')} calls).`;
    case 'unknown_model_surge':
      return `${num(details, 'count')} events priced at $0 (unknown model) in the last ${num(details, 'windowHours')}h — above the ${num(details, 'threshold')} threshold.`;
    case 'budget_threshold':
      return `Org spend reached ${(num(details, 'ratio') * 100).toFixed(0)}% of the $${num(details, 'budgetUsd').toFixed(2)} budget ($${num(details, 'spend').toFixed(2)} over the last ${num(details, 'windowDays')} days).`;
    default:
      return 'An alert rule fired.';
  }
}

// `baseUrl` is injected from the Zod-validated loadConfig() (CLAUDE.md: only
// loadConfig touches process.env). Empty → relative dashboard link.
export function buildAlertPayload(rule: RuleLike, event: EventLike, baseUrl = ''): AlertPayload {
  return {
    description: describe(rule.ruleType, event.details),
    firedAt: event.firedAt.toISOString(),
    ruleName: rule.name,
    severity: event.severity,
    url: `${baseUrl}/org/dashboard`,
  };
}
