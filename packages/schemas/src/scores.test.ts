import { describe, expect, it } from 'vitest';

import { FRICTION_VERSION } from './effectiveness';
import {
  buildScoreRow,
  isEmptyScore,
  SCORER_NAMES,
  SCORERS,
  type ScorerDefinition,
  SESSION_SHAPE_VERSION,
  trailingWindow,
} from './scores';

describe('scorer registry', () => {
  it('exposes every registered scorer by name', () => {
    expect(SCORER_NAMES).toContain('friction');
    expect(SCORER_NAMES).toContain('session_shape');
    expect(SCORER_NAMES).toHaveLength(Object.keys(SCORERS).length);
  });

  it('tracks the friction version from the scorer that owns it', () => {
    // The registry must not carry its own copy — a second constant would drift
    // silently from the weights it is supposed to describe.
    expect(SCORERS.friction.version).toBe(FRICTION_VERSION);
  });

  it('versions the shape classifier independently of friction', () => {
    expect(SCORERS.session_shape.version).toBe(SESSION_SHAPE_VERSION);
  });

  it('declares a kind, source and subject for every scorer', () => {
    for (const name of SCORER_NAMES) {
      const def = SCORERS[name];
      expect(def.description.length).toBeGreaterThan(0);
      expect(['NUMERIC', 'CATEGORICAL']).toContain(def.kind);
      expect(['HEURISTIC', 'DETERMINISTIC', 'HUMAN', 'JUDGE', 'OUTCOME']).toContain(def.source);
      expect(['SESSION', 'PULL_REQUEST', 'SKILL', 'MCP_SERVER']).toContain(def.subjectType);
      expect(Number.isInteger(def.version)).toBe(true);
      expect(def.version).toBeGreaterThan(0);
    }
  });
});

describe('buildScoreRow', () => {
  it('fills subject type, source and version from the registry', () => {
    const row = buildScoreRow({ scorerName: 'friction', subjectId: 'abc', value: 0.42 });

    expect(row).toMatchObject({
      scorerName: 'friction',
      scorerVersion: FRICTION_VERSION,
      source: 'HEURISTIC',
      subjectId: 'abc',
      subjectType: 'SESSION',
      value: 0.42,
    });
  });

  it('defaults the optional columns rather than leaving them undefined', () => {
    const row = buildScoreRow({ label: 'debugging', scorerName: 'session_shape', subjectId: 'x' });

    expect(row.costUsd).toBeNull();
    expect(row.rationaleRef).toBeNull();
    expect(row.value).toBeNull();
    expect(row.metadata).toEqual({});
  });

  it('carries cost and provenance when supplied', () => {
    const row = buildScoreRow({
      costUsd: 0.0031,
      metadata: { baseline: 'p50-implementation', sampleSize: 41 },
      rationaleRef: 'rationales/2026/08/abc.json',
      scorerName: 'friction',
      subjectId: 'abc',
      value: 0.1,
    });

    expect(row.costUsd).toBe(0.0031);
    expect(row.rationaleRef).toBe('rationales/2026/08/abc.json');
    expect(row.metadata).toEqual({ baseline: 'p50-implementation', sampleSize: 41 });
  });
});

describe('isEmptyScore', () => {
  it('treats a numeric scorer with no value as empty', () => {
    // computeFrictionScore legitimately returns null for low-data sessions;
    // writing a row anyway would report "not enough data" as "scored".
    expect(isEmptyScore({ scorerName: 'friction', subjectId: 'a', value: null })).toBe(true);
    expect(isEmptyScore({ scorerName: 'friction', subjectId: 'a' })).toBe(true);
  });

  it('treats zero as a real numeric score', () => {
    expect(isEmptyScore({ scorerName: 'friction', subjectId: 'a', value: 0 })).toBe(false);
  });

  it('treats a categorical scorer with no label as empty', () => {
    expect(isEmptyScore({ label: null, scorerName: 'session_shape', subjectId: 'a' })).toBe(true);
    expect(isEmptyScore({ label: '', scorerName: 'session_shape', subjectId: 'a' })).toBe(true);
    expect(isEmptyScore({ label: 'planning', scorerName: 'session_shape', subjectId: 'a' })).toBe(
      false,
    );
  });

  it('ignores the wrong-kind column when judging emptiness', () => {
    // A numeric scorer carrying a stray label is still empty without a value.
    expect(isEmptyScore({ label: 'oops', scorerName: 'friction', subjectId: 'a' })).toBe(true);
  });
});

describe('periodic scorers (P13-013)', () => {
  const period = { end: new Date('2026-08-18T00:00:00Z'), start: new Date('2026-07-19T00:00:00Z') };

  it('rejects a periodic scorer with no period', () => {
    // Silent otherwise: the row would be written with a NULL period, every
    // nightly run would overwrite it, and the trend would never accumulate.
    expect(() =>
      buildScoreRow({ scorerName: 'skill_effectiveness', subjectId: 'skill:x', value: 0.1 }),
    ).toThrow(/periodic and needs a period/);
  });

  it('rejects a one-shot scorer that supplies a period', () => {
    // Also silent otherwise: a session's single score would split into one row
    // per run instead of being corrected in place.
    expect(() =>
      buildScoreRow({ period, scorerName: 'friction', subjectId: 'abc', value: 0.4 }),
    ).toThrow(/not periodic/);
  });

  it('carries the period through for a periodic scorer', () => {
    const row = buildScoreRow({
      period,
      scorerName: 'mcp_effectiveness',
      subjectId: 'linear',
      value: 0.05,
    });
    expect(row.periodStart).toEqual(period.start);
    expect(row.periodEnd).toEqual(period.end);
  });

  it('leaves the period null for everything else', () => {
    const row = buildScoreRow({ scorerName: 'friction', subjectId: 'abc', value: 0.4 });
    expect(row.periodStart).toBeNull();
    expect(row.periodEnd).toBeNull();
  });

  it('marks exactly the subject-scoped scorers periodic', () => {
    // A periodic scorer whose subject is a SESSION would be a contradiction:
    // sessions do not recur, so there would be nothing for a second period to
    // describe.
    for (const name of SCORER_NAMES) {
      const def: ScorerDefinition = SCORERS[name];
      if (def.periodic) {
        expect(['SKILL', 'MCP_SERVER']).toContain(def.subjectType);
      }
    }
  });
});

describe('trailingWindow', () => {
  it('truncates to the day so two runs the same night agree', () => {
    const a = trailingWindow(30, new Date('2026-08-18T00:00:01Z'));
    const b = trailingWindow(30, new Date('2026-08-18T23:59:59Z'));
    expect(a).toEqual(b);
  });

  it('spans exactly the requested number of days', () => {
    const { end, start } = trailingWindow(30, new Date('2026-08-18T12:00:00Z'));
    expect((end.getTime() - start.getTime()) / 86_400_000).toBe(30);
  });

  it('moves to a new bucket the next day', () => {
    const today = trailingWindow(30, new Date('2026-08-18T12:00:00Z'));
    const tomorrow = trailingWindow(30, new Date('2026-08-19T12:00:00Z'));
    expect(tomorrow.start.getTime() - today.start.getTime()).toBe(86_400_000);
  });
});
