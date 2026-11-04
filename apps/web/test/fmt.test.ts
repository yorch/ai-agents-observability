import { describe, expect, it } from 'vitest';

import { fmtFriction } from '../src/lib/fmt';

describe('fmtFriction', () => {
  it('renders the 0-1 score at 2dp, never as a percentage', () => {
    expect(fmtFriction(0.4871)).toBe('0.49');
    expect(fmtFriction(0)).toBe('0.00');
    expect(fmtFriction(1)).toBe('1.00');
  });
});
