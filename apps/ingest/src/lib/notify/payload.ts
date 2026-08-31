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

// Uppercase severity tag for text channels (email subject + body), so the label
// casing stays consistent across a single notification.
export function severityLabel(severity: AlertSeverity): string {
  return severity === 'critical' ? 'CRITICAL' : 'WARN';
}

// Names the models an unknown-model alert found, so the notification says what
// to add rather than only that something is missing. Tolerates a details blob
// written before `models` existed (older alert_events rows replay through here).
function unknownModelList(details: Record<string, unknown>): string {
  const models = details.models;
  if (!Array.isArray(models) || models.length === 0) {
    return '';
  }
  const named = models
    .filter(
      (m): m is { agentType: string; count: number; model: string } =>
        typeof m === 'object' && m !== null && typeof (m as { model?: unknown }).model === 'string',
    )
    .map((m) => `${m.agentType?.toLowerCase() ?? '?'}:${m.model} (${m.count})`);
  return named.length > 0 ? ` Unpriced: ${named.join(', ')}.` : '';
}

// Names the redaction classes a secret-exposure alert found, so the notification
// says what kind of secret spiked rather than only that something did. Tolerates
// a details blob written before `classes` existed (older alert_events rows).
function secretExposureClassList(details: Record<string, unknown>): string {
  const classes = details.classes;
  if (!Array.isArray(classes) || classes.length === 0) {
    return '';
  }
  const named = classes
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null && typeof c.class === 'string',
    )
    .map((c) => `${c.class} (${num(c, 'sessionsWithClass')})`);
  return named.length > 0 ? ` Classes: ${named.join(', ')}.` : '';
}

// Names the teams whose spend spiked, so the notification says which team to
// investigate. Tolerates a details blob written before `teams` existed, and a
// partial `teams` entry missing numeric fields (uses `num()` for safe coercion).
function teamSpendSpikeList(details: Record<string, unknown>): string {
  const teams = details.teams;
  if (!Array.isArray(teams) || teams.length === 0) {
    return '';
  }
  const named = teams
    .filter(
      (t): t is Record<string, unknown> =>
        typeof t === 'object' && t !== null && typeof t.teamSlug === 'string',
    )
    .map(
      (t) => `${t.teamSlug} (${num(t, 'sigma').toFixed(1)}σ, $${num(t, 'currentCost').toFixed(2)})`,
    );
  return named.length > 0 ? `Teams: ${named.join(', ')}. ` : '';
}

// Human-readable, aggregate-only description per rule type.
function describe(ruleType: string, details: Record<string, unknown>): string {
  switch (ruleType) {
    case 'spend_spike':
      return `Org spend spiked ${num(details, 'sigma').toFixed(1)}σ above the ${num(details, 'windowDays')}-day baseline ($${num(details, 'currentCost').toFixed(2)} vs $${num(details, 'avgCost').toFixed(2)}/period avg).`;
    case 'high_error_rate':
      return `Tool error rate is ${(num(details, 'errorRate') * 100).toFixed(1)}% (${num(details, 'errors')} errors / ${num(details, 'calls')} calls).`;
    case 'unknown_model_surge':
      return `${num(details, 'count')} events priced at $0 (unknown model) in the last ${num(details, 'windowHours')}h — above the ${num(details, 'threshold')} threshold.${unknownModelList(details)}`;
    case 'budget_threshold':
      return `Org spend reached ${(num(details, 'ratio') * 100).toFixed(0)}% of the $${num(details, 'budgetUsd').toFixed(2)} budget ($${num(details, 'spend').toFixed(2)} over the last ${num(details, 'windowDays')} days).`;
    case 'autonomy_surge':
      return `${(num(details, 'share') * 100).toFixed(0)}% of sessions ran with no per-action human gate (${num(details, 'lowOversightSessions')} of ${num(details, 'totalSessions')}) over the last ${num(details, 'windowDays')} days — human oversight is eroding.`;
    case 'routing_waste':
      // The spend is a redistribution of each issuing turn's cost onto the calls
      // it made (P14-004/P14-005), which only exists for events carrying turn
      // linkage — so the call coverage travels with the figure. Counts only, like
      // every other field here.
      return `$${num(details, 'wasteUsd').toFixed(2)} of premium-model spend went to retrieval-only tool calls over the last ${num(details, 'windowDays')} days — above the $${num(details, 'thresholdUsd').toFixed(2)} threshold. Routing these to a cheaper model would recover most of it. Attributed over ${num(details, 'attributedCalls')} of ${num(details, 'callCount')} matching calls.`;
    case 'disallowed_model':
      // Counts only — never the model names. `num()` reads specific numeric keys
      // by name, so a stray string in `details` cannot reach a channel.
      return `$${num(details, 'spendUsd').toFixed(2)} of spend went to models outside the approved allow-list over the last ${num(details, 'windowDays')} days (${num(details, 'eventCount')} events across ${num(details, 'sessionCount')} sessions, ${num(details, 'distinctModels')} non-approved models) — above the $${num(details, 'thresholdUsd').toFixed(2)} threshold.`;
    case 'secret_exposure':
      // Redaction class names are categories (aws-access-key, github-token, …),
      // not individuals, so naming them keeps the aggregate-only guarantee —
      // the same reasoning as the model names in unknown_model_surge.
      return `${num(details, 'count')} sessions shipped transcripts containing secrets in the last ${num(details, 'windowDays')} days — above the ${num(details, 'threshold')} threshold.${secretExposureClassList(details)}`;
    case 'team_spend_spike':
      // Team slugs are GitHub-derived org identifiers, not individuals — naming
      // them keeps the aggregate-only guarantee, like model names in
      // unknown_model_surge. The list is capped in the evaluator.
      return `${teamSpendSpikeList(details)}spend spiked in the last ${num(details, 'windowDays')} days across one or more teams — see /org/dashboard for per-team details.`;
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
