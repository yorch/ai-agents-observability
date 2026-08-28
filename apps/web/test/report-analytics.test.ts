import { describe, expect, test } from 'vitest';
import { type ReportDigest, reportCsv, reportMarkdown } from '../src/lib/reporting';
import { parseReportRange } from '../src/lib/reporting-range';
import { completeWeeks } from '../src/lib/weekly-digest';

describe('report analytics semantics', () => {
  test('custom ranges are bounded and reject invalid timezones', () => {
    const range = parseReportRange(
      { from: '2026-08-01', to: '2026-08-08', tz: 'not/a-zone' },
      new Date('2026-08-10T00:00:00Z'),
    );
    expect(range.from).toBe('2026-08-01');
    expect(range.to).toBe('2026-08-08');
    expect(range.timezone).toBe('UTC');
  });

  test('weekly digest excludes the current partial week', () => {
    const points = [
      { costUsd: 2, day: new Date('2026-08-24T00:00:00Z'), models: [], sessionCount: 2 },
      { costUsd: 3, day: new Date('2026-08-28T00:00:00Z'), models: [], sessionCount: 3 },
      { costUsd: 1, day: new Date('2026-08-17T00:00:00Z'), models: [], sessionCount: 1 },
    ];
    expect(completeWeeks(points, new Date('2026-08-29T00:00:00Z'))).toHaveLength(1);
  });

  test('exports preserve chart data', () => {
    const report = {
      analytics: {
        concurrency: [],
        heatmap: [],
        scatter: [],
        trends: [{ costUsd: 1, day: '2026-08-22', sessionCount: 2 }],
      },
      generatedAt: '2026-08-28T00:00:00Z',
      metrics: [],
      notes: [],
      period: { days: 7, end: '2026-08-28', start: '2026-08-21' },
      scope: { label: 'My', type: 'me' as const },
      topModels: [],
      topTools: [],
    } satisfies ReportDigest;
    expect(reportMarkdown(report)).toContain('Daily trends');
    expect(reportCsv(report)).toContain('trend,2026-08-22');
  });
});
