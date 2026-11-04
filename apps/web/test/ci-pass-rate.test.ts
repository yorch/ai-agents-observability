import { describe, expect, it } from 'vitest';

import { ciPassRate } from '../src/lib/ci-pass-rate';
import { mapSkillRoiRows } from '../src/lib/org-queries';

describe('skill x CI pass rate', () => {
  it('normalises the uppercase wire enum so pass rate is not always 0%', () => {
    const rows = mapSkillRoiRows([
      { ci_status: 'SUCCESS', session_count: 8n, skill_name: 'code-review' },
      { ci_status: 'FAILURE', session_count: 2n, skill_name: 'code-review' },
      { ci_status: 'PENDING', session_count: 10n, skill_name: 'code-review' },
    ]);
    expect(rows.map((r) => r.ciStatus)).toEqual(['success', 'failure', 'pending']);
    expect(ciPassRate(rows)).toBeCloseTo(0.8);
  });

  it('excludes pending and returns null when nothing is decided', () => {
    expect(ciPassRate([{ ciStatus: 'pending', sessionCount: 5 }])).toBeNull();
    expect(ciPassRate([])).toBeNull();
  });
});
