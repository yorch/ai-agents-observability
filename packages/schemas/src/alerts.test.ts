import { describe, expect, it } from 'vitest';

import {
  BUDGET_THRESHOLD_WINDOW_DAYS,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  parseBudgetThresholdParams,
  UNKNOWN_MODEL_SURGE_DEFAULT,
} from './alerts';

describe('shared alert thresholds', () => {
  it('keeps warn thresholds below critical thresholds', () => {
    expect(ERROR_RATE_WARN).toBeLessThan(ERROR_RATE_CRITICAL);
    expect(ERROR_RATE_MIN_CALLS).toBeGreaterThan(0);
    expect(UNKNOWN_MODEL_SURGE_DEFAULT).toBeGreaterThan(0);
  });
});

describe('parseBudgetThresholdParams', () => {
  it('parses a fully configured rule', () => {
    expect(parseBudgetThresholdParams({ budgetUsd: 5000, windowDays: 7 })).toEqual({
      budgetUsd: 5000,
      windowDays: 7,
    });
  });

  it('defaults windowDays when omitted', () => {
    expect(parseBudgetThresholdParams({ budgetUsd: 5000 })).toEqual({
      budgetUsd: 5000,
      windowDays: BUDGET_THRESHOLD_WINDOW_DAYS,
    });
  });

  it('coerces numeric strings (form/JSON input)', () => {
    expect(parseBudgetThresholdParams({ budgetUsd: '5000', windowDays: '14' })).toEqual({
      budgetUsd: 5000,
      windowDays: 14,
    });
  });

  it('falls back to the default window for a malformed windowDays instead of NaN', () => {
    // A present-but-non-numeric windowDays must not produce an Invalid Date window
    // (which would silently disable the rule); it falls back to the default.
    for (const bad of ['abc', {}, [], 0, -3, 2.5]) {
      expect(parseBudgetThresholdParams({ budgetUsd: 5000, windowDays: bad })?.windowDays).toBe(
        BUDGET_THRESHOLD_WINDOW_DAYS,
      );
    }
  });

  it('returns null (rule inert) when the budget is missing or non-positive', () => {
    expect(parseBudgetThresholdParams({})).toBeNull();
    expect(parseBudgetThresholdParams(null)).toBeNull();
    expect(parseBudgetThresholdParams({ windowDays: 30 })).toBeNull();
    expect(parseBudgetThresholdParams({ budgetUsd: 0 })).toBeNull();
    expect(parseBudgetThresholdParams({ budgetUsd: -100 })).toBeNull();
    expect(parseBudgetThresholdParams({ budgetUsd: 'not-a-number' })).toBeNull();
  });
});
