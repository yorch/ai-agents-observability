import { describe, expect, it, vi } from 'vitest';

import { dispatchAlert } from '../src/lib/notify/channel';
import { buildAlertPayload } from '../src/lib/notify/payload';

describe('buildAlertPayload (trust guardrail — aggregate only)', () => {
  const rule = { name: 'Org spend spike', ruleType: 'spend_spike' };
  const event = {
    details: { avgCost: 100, currentCost: 420, sigma: 3.2, stddev: 50, windowDays: 7 },
    firedAt: new Date('2026-06-24T12:00:00Z'),
    severity: 'critical' as const,
  };

  it('contains rule name, severity, fired_at, a description, and a dashboard link', () => {
    const p = buildAlertPayload(rule, event, 'https://obs.example');
    expect(p.ruleName).toBe('Org spend spike');
    expect(p.severity).toBe('critical');
    expect(p.firedAt).toBe('2026-06-24T12:00:00.000Z');
    expect(p.description).toContain('3.2σ');
    expect(p.url).toBe('https://obs.example/org/dashboard');
  });

  it('names the unpriced models in an unknown_model_surge description', () => {
    const p = buildAlertPayload(
      { name: 'Unknown-model surge', ruleType: 'unknown_model_surge' },
      {
        details: {
          count: 73,
          models: [
            // Two shapes an operator really sees: an alias tag, deliberately
            // unpriced because it is repointed without its name changing; and a
            // model from a provider the tables do not cover.
            { agentType: 'GEMINI_CLI', count: 60, model: 'gemini-flash-latest' },
            { agentType: 'PI', count: 13, model: 'ollama/llama4' },
          ],
          threshold: 10,
          windowHours: 24,
        },
        firedAt: new Date('2026-06-24T12:00:00Z'),
        severity: 'warn',
      },
    );
    // A count alone leaves the operator grepping logs for what to add.
    expect(p.description).toContain('73 events');
    expect(p.description).toContain('gemini_cli:gemini-flash-latest (60)');
    expect(p.description).toContain('pi:ollama/llama4 (13)');
  });

  it('still renders unknown_model_surge for a details blob written before `models`', () => {
    // alert_events rows persisted by an older build replay through this.
    const p = buildAlertPayload(
      { name: 'Unknown-model surge', ruleType: 'unknown_model_surge' },
      {
        details: { count: 5, threshold: 1, windowHours: 24 },
        firedAt: new Date('2026-06-24T12:00:00Z'),
        severity: 'warn',
      },
    );
    expect(p.description).toContain('5 events');
    expect(p.description).not.toContain('Unpriced:');
  });

  it('renders an aggregate-only budget_threshold description', () => {
    const p = buildAlertPayload(
      { name: 'Org budget threshold', ruleType: 'budget_threshold' },
      {
        details: { budgetUsd: 1000, ratio: 0.92, spend: 920, windowDays: 30 },
        firedAt: new Date('2026-06-24T12:00:00Z'),
        severity: 'warn',
      },
    );
    expect(p.description).toContain('92%');
    expect(p.description).toContain('$1000.00');
    expect(p.description).toContain('$920.00');
    expect(p.description).toContain('30 days');
  });

  it('carries NO individual-identifying data (no session/user/login/transcript)', () => {
    const serialized = JSON.stringify(
      buildAlertPayload(rule, {
        ...event,
        // Even if a future bug leaked an id into details, the payload must not echo it.
        details: { ...event.details, login: 'leak', sessionId: 'leak', userId: 'leak' },
      }),
    ).toLowerCase();
    expect(serialized).not.toContain('sessionid');
    expect(serialized).not.toContain('userid');
    expect(serialized).not.toContain('login');
    expect(serialized).not.toContain('leak');
  });

  it('names the redaction classes in a secret_exposure description', () => {
    const p = buildAlertPayload(
      { name: 'Secret exposure surge', ruleType: 'secret_exposure' },
      {
        details: {
          classes: [
            { class: 'github-token', sessionsWithClass: 5 },
            { class: 'aws-access-key', sessionsWithClass: 3 },
          ],
          count: 8,
          threshold: 5,
          windowDays: 7,
        },
        firedAt: new Date('2026-06-24T12:00:00Z'),
        severity: 'warn',
      },
    );
    expect(p.description).toContain('8 sessions');
    expect(p.description).toContain('7 days');
    expect(p.description).toContain('github-token (5)');
    expect(p.description).toContain('aws-access-key (3)');
  });

  it('still renders secret_exposure for a details blob written before `classes`', () => {
    const p = buildAlertPayload(
      { name: 'Secret exposure surge', ruleType: 'secret_exposure' },
      {
        details: { count: 6, threshold: 5, windowDays: 7 },
        firedAt: new Date('2026-06-24T12:00:00Z'),
        severity: 'warn',
      },
    );
    expect(p.description).toContain('6 sessions');
    expect(p.description).not.toContain('Classes:');
  });
});

describe('dispatchAlert', () => {
  const payload = buildAlertPayload(
    { name: 'r', ruleType: 'spend_spike' },
    { details: {}, firedAt: new Date('2026-06-24T12:00:00Z'), severity: 'warn' },
  );

  function makeDb() {
    const logs: { error: string | null; success: boolean }[] = [];
    return {
      _logs: logs,
      alertDeliveryLog: {
        create: vi.fn(async (args: { data: { error: string | null; success: boolean } }) => {
          logs.push({ error: args.data.error, success: args.data.success });
          return {};
        }),
      },
    };
  }

  it('skips disabled channels', async () => {
    const db = makeDb();
    await dispatchAlert(
      db,
      [{ channelType: 'webhook', config: { url: 'http://x' }, enabled: false }],
      payload,
      { sleep: async () => {} },
    );
    expect(db._logs).toHaveLength(0);
  });

  it('logs a failure (no throw) and retries an unknown channel 3x', async () => {
    const db = makeDb();
    await dispatchAlert(db, [{ channelType: 'bogus', config: {}, enabled: true }], payload, {
      sleep: async () => {},
    });
    expect(db._logs).toHaveLength(1);
    expect(db._logs[0]?.success).toBe(false);
    expect(db._logs[0]?.error).toContain('Unknown channel');
  });
});
