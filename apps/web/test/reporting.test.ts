import { describe, expect, test } from 'vitest';
import {
  csvCell,
  formatReportDelta,
  type ReportDigest,
  reportBundle,
  reportCsv,
  reportHtml,
  reportMarkdown,
} from '../src/lib/reporting';

const report: ReportDigest = {
  generatedAt: '2026-08-27T00:00:00.000Z',
  metrics: [
    { current: 12.4, label: 'Spend', prior: 10.5, unit: 'usd' },
    { current: 3, label: 'Sessions', prior: 0, unit: 'count' },
  ],
  notes: ['Only interactive runs are included.'],
  period: { days: 7, end: '2026-08-24', start: '2026-08-18' },
  scope: { label: 'My', type: 'me' },
  topModels: [{ costUsd: 12.4, model: 'codex', sessions: 3 }],
  topTools: [{ calls: 9, name: 'shell' }],
};

describe('reporting renderers', () => {
  test('uses a completed comparison period and a safe zero-baseline label', () => {
    const markdown = reportMarkdown(report);
    expect(markdown).toContain('Trailing 7-day period, compared with the preceding 7 days.');
    expect(markdown).toContain('+3 (new)');
    const spend = report.metrics.find((metric) => metric.label === 'Spend');
    expect(spend && formatReportDelta(spend)).toBe('+$1.90 (+18%)');
  });

  test('includes report metadata, aggregate detail, and caveats in Markdown', () => {
    const markdown = reportMarkdown(report);
    expect(markdown).toContain('## My agent digest — 2026-08-18 to 2026-08-24');
    expect(markdown).toContain('### Top models');
    expect(markdown).toContain('### Top tools');
    expect(markdown).toContain('Only interactive runs are included.');
  });

  test('protects CSV cells from spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("https://bad.example")')).toBe(
      `"'=HYPERLINK(""https://bad.example"")"`,
    );
    expect(reportCsv({ ...report, topTools: [{ calls: 1, name: '=SUM(A1:A2)' }] })).toContain(
      "'=SUM(A1:A2)",
    );
  });

  test('creates an aggregate-only bundle with portable report files', () => {
    const bundle = reportBundle(report);
    expect(bundle.manifest.visibility).toEqual({
      includesMemberLevelData: false,
      includesTranscripts: false,
      policy: 'self-aggregate',
    });
    expect(bundle.files.map((file) => file.path)).toEqual([
      'report.json',
      'report.md',
      'report.csv',
      'report.html',
    ]);
    expect(bundle.files.find((file) => file.path === 'report.json')?.content).toContain(
      '"topModels"',
    );
  });

  test('escapes untrusted labels in the HTML snapshot', () => {
    const html = reportHtml({ ...report, scope: { label: '<Org>', type: 'org' } });
    expect(html).toContain('&lt;Org&gt;');
    expect(html).not.toContain('<Org>');
  });
});
