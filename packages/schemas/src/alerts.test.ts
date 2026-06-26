import { describe, expect, it } from 'vitest';

import {
  ERROR_RATE_CRITICAL,
  ERROR_RATE_MIN_CALLS,
  ERROR_RATE_WARN,
  UNKNOWN_MODEL_SURGE_DEFAULT,
} from './alerts';

describe('shared alert thresholds', () => {
  it('keeps warn thresholds below critical thresholds', () => {
    expect(ERROR_RATE_WARN).toBeLessThan(ERROR_RATE_CRITICAL);
    expect(ERROR_RATE_MIN_CALLS).toBeGreaterThan(0);
    expect(UNKNOWN_MODEL_SURGE_DEFAULT).toBeGreaterThan(0);
  });
});
