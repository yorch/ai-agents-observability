import { describe, expect, it, vi } from 'vitest';

import { dispatchAlert } from '../src/lib/notify/channel.ts';
import { buildAlertPayload } from '../src/lib/notify/payload.ts';

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
      undefined,
      undefined,
      async () => {},
    );
    expect(db._logs).toHaveLength(0);
  });

  it('logs a failure (no throw) and retries an unknown channel 3x', async () => {
    const db = makeDb();
    await dispatchAlert(
      db,
      [{ channelType: 'bogus', config: {}, enabled: true }],
      payload,
      undefined,
      undefined,
      async () => {},
    );
    expect(db._logs).toHaveLength(1);
    expect(db._logs[0]?.success).toBe(false);
    expect(db._logs[0]?.error).toContain('Unknown channel');
  });
});
