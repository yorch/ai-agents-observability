import {
  DISALLOWED_MODEL_CRITICAL_MULTIPLE,
  DISALLOWED_MODEL_WINDOW_DAYS,
} from '@ai-agents-observability/schemas';
import { describe, expect, it, vi } from 'vitest';

import { evalDisallowedModel } from '../src/jobs/evaluate-alerts';
import { buildAlertPayload } from '../src/lib/notify/payload';

// Model governance enforcement (P10-005). Prisma-free: the evaluator's only DB
// access is one $queryRaw, so canned rows exercise every branch without a live
// database — the same style as the rest of the Phase 9 alert suite.

type Row = {
  distinct_models: number;
  event_count: number;
  session_count: number;
  spend: number;
};

type Db = Parameters<typeof evalDisallowedModel>[0];

function dbReturning(row: Row) {
  const $queryRaw = vi.fn(async () => [row]);
  return { $queryRaw, db: { $queryRaw } as unknown as Db };
}

const row = (spend: number): Row => ({
  distinct_models: 2,
  event_count: 40,
  session_count: 5,
  spend,
});

const THRESHOLD = { thresholdUsd: 50 };

describe('evalDisallowedModel', () => {
  it('fires with warn severity when disallowed spend crosses the threshold', async () => {
    const { db } = dbReturning(row(75));
    const result = await evalDisallowedModel(db, THRESHOLD);
    expect(result?.severity).toBe('warn');
    expect(result?.details).toEqual({
      distinctModels: 2,
      eventCount: 40,
      sessionCount: 5,
      spendUsd: 75,
      thresholdUsd: 50,
      windowDays: DISALLOWED_MODEL_WINDOW_DAYS,
    });
  });

  it('does not fire below the threshold', async () => {
    const { db } = dbReturning(row(49.99));
    expect(await evalDisallowedModel(db, THRESHOLD)).toBeNull();
  });

  it('escalates to critical at the critical multiple', async () => {
    const { db } = dbReturning(row(50 * DISALLOWED_MODEL_CRITICAL_MULTIPLE));
    expect((await evalDisallowedModel(db, THRESHOLD))?.severity).toBe('critical');
  });

  it('stays silent when nothing is disallowed — the unconfigured-allow-list case', async () => {
    // An org with no model_policy rows (or only empty allow-lists) makes the
    // query report zero: an unconfigured policy means "unconfigured", never
    // "deny everything". Enabling the rule on a fresh install must be inert.
    const { db } = dbReturning({ distinct_models: 0, event_count: 0, session_count: 0, spend: 0 });
    expect(await evalDisallowedModel(db, THRESHOLD)).toBeNull();
  });

  it('is inert for a non-positive configured threshold and never queries', async () => {
    const { db, $queryRaw } = dbReturning(row(1000));
    expect(await evalDisallowedModel(db, { thresholdUsd: 0 })).toBeNull();
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('scopes the query to configured, non-empty allow-lists and shared metadata', async () => {
    const { db, $queryRaw } = dbReturning(row(75));
    await evalDisallowedModel(db, THRESHOLD);
    const [statement] = $queryRaw.mock.calls[0] as unknown as [{ strings: string[] }];
    const sql = statement.strings.join(' ');
    // INNER JOIN: an agent_type with no model_policy row contributes nothing.
    expect(sql).toMatch(/JOIN model_policy mp ON mp\.agent_type::text = e\.agent_type/);
    // A row that exists but carries an empty allow-list contributes nothing
    // either (array_length is NULL, not 0, for an empty array).
    expect(sql).toContain('COALESCE(array_length(mp.allowed_models, 1), 0) > 0');
    expect(sql).toContain('NOT (e.model = ANY(mp.allowed_models))');
    // Same visibility guard as every other evaluator.
    expect(sql).toContain('u.deactivated_at IS NULL');
    expect(sql).toContain('COALESCE(vp.share_metadata_with_org, true) = true');
  });

  it('reports only numbers — details never carries a model name', async () => {
    const { db } = dbReturning(row(75));
    const details = (await evalDisallowedModel(db, THRESHOLD))?.details ?? {};
    for (const value of Object.values(details)) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('buildAlertPayload — disallowed_model', () => {
  const rule = { name: 'Disallowed model spend', ruleType: 'disallowed_model' };
  const details = {
    distinctModels: 2,
    eventCount: 40,
    sessionCount: 5,
    spendUsd: 75.5,
    thresholdUsd: 50,
    windowDays: 7,
  };

  it('describes the violation in aggregate terms', () => {
    const p = buildAlertPayload(
      rule,
      { details, firedAt: new Date('2026-08-18T12:00:00Z'), severity: 'warn' },
      'https://obs.example',
    );
    expect(p.ruleName).toBe('Disallowed model spend');
    expect(p.description).toContain('$75.50');
    expect(p.description).toContain('7 days');
    expect(p.description).toContain('40 events');
    expect(p.description).toContain('5 sessions');
    expect(p.description).toContain('2 non-approved models');
    expect(p.description).toContain('$50.00');
    expect(p.url).toBe('https://obs.example/org/dashboard');
  });

  it('carries no individual-identifying data even if details are poisoned', () => {
    const serialized = JSON.stringify(
      buildAlertPayload(rule, {
        details: {
          ...details,
          login: 'octocat',
          model: 'claude-opus-5',
          sessionId: '01906a44-0000-7000-8000-000000000000',
          userId: 'u-9f3a',
        },
        firedAt: new Date('2026-08-18T12:00:00Z'),
        severity: 'critical',
      }),
    );
    for (const secret of [
      'octocat',
      'claude-opus-5',
      '01906a44-0000-7000-8000-000000000000',
      'u-9f3a',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    const lowered = serialized.toLowerCase();
    expect(lowered).not.toContain('sessionid');
    expect(lowered).not.toContain('userid');
    expect(lowered).not.toContain('login');
  });
});
