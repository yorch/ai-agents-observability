/**
 * Pure report model and renderers. Query code supplies only aggregate rows, so
 * the Markdown, JSON, CSV, and UI representations cannot disagree about a
 * report's period, delta, or disclosure note.
 */
export type ReportMetric = {
  current: number;
  label: string;
  prior: number;
  unit: 'count' | 'hours' | 'percent' | 'usd';
};

export type ReportDigest = {
  generatedAt: string;
  metrics: ReportMetric[];
  notes: string[];
  period: { days: number; end: string; start: string };
  scope: { label: string; type: 'me' | 'org' | 'team' };
  topModels: { costUsd: number; model: string; sessions: number }[];
  topTools: { calls: number; name: string }[];
};

export function reportDelta(
  current: number,
  prior: number,
): {
  absolute: number;
  relative: number | null;
} {
  return { absolute: current - prior, relative: prior === 0 ? null : (current - prior) / prior };
}

function formatValue(value: number, unit: ReportMetric['unit']): string {
  if (unit === 'usd') {
    return `$${value.toFixed(2)}`;
  }
  if (unit === 'hours') {
    return `${value.toFixed(1)}h`;
  }
  if (unit === 'percent') {
    return `${value.toFixed(1)}%`;
  }
  return Math.round(value).toLocaleString();
}

export function formatReportDelta(metric: ReportMetric): string {
  const delta = reportDelta(metric.current, metric.prior);
  if (delta.absolute === 0) {
    return 'no change';
  }
  const sign = delta.absolute > 0 ? '+' : '';
  const formatted = formatValue(Math.abs(delta.absolute), metric.unit);
  const amount = `${sign}${delta.absolute < 0 ? '-' : ''}${formatted}`;
  if (delta.relative === null) {
    return `${amount} (new)`;
  }
  return `${amount} (${delta.relative >= 0 ? '+' : ''}${(delta.relative * 100).toFixed(0)}%)`;
}

function table(rows: string[][]): string {
  return rows
    .map((row) => `| ${row.map((value) => value.replaceAll('|', '\\|')).join(' | ')} |`)
    .join('\n');
}

/** Paste-ready CommonMark. Keep renderer deterministic for snapshots and APIs. */
export function reportMarkdown(report: ReportDigest): string {
  const out = [
    `## ${report.scope.label} agent digest — ${report.period.start} to ${report.period.end}`,
    '',
    `Trailing ${report.period.days}-day period, compared with the preceding ${report.period.days} days.`,
    '',
    '### Summary',
    '',
    table([
      ['Metric', 'This period', 'Prior', 'Change'],
      ['---', '---:', '---:', '---:'],
      ...report.metrics.map((metric) => [
        metric.label,
        formatValue(metric.current, metric.unit),
        formatValue(metric.prior, metric.unit),
        formatReportDelta(metric),
      ]),
    ]),
  ];

  if (report.topModels.length > 0) {
    out.push(
      '',
      '### Top models',
      '',
      table([
        ['Model', 'Sessions', 'Cost'],
        ['---', '---:', '---:'],
        ...report.topModels.map((row) => [
          row.model,
          String(row.sessions),
          `$${row.costUsd.toFixed(2)}`,
        ]),
      ]),
    );
  }
  if (report.topTools.length > 0) {
    out.push(
      '',
      '### Top tools',
      '',
      table([
        ['Tool', 'Calls'],
        ['---', '---:'],
        ...report.topTools.map((row) => [row.name, row.calls.toLocaleString()]),
      ]),
    );
  }
  if (report.notes.length > 0) {
    out.push('', '### Notes', '', ...report.notes.map((note) => `- ${note}`));
  }
  return `${out.join('\n')}\n`;
}

/** CSV formula injection must be handled in every export surface. */
export function csvCell(value: string | number): string {
  let cell = String(value);
  if (/^[=+\-@]/.test(cell)) {
    cell = `'${cell}`;
  }
  return /[",\n']/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function reportCsv(report: ReportDigest): string {
  const rows = [
    ['section', 'label', 'current', 'prior', 'change'],
    ...report.metrics.map((metric) => [
      'summary',
      metric.label,
      formatValue(metric.current, metric.unit),
      formatValue(metric.prior, metric.unit),
      formatReportDelta(metric),
    ]),
    ...report.topModels.map((row) => [
      'model',
      row.model,
      String(row.sessions),
      `$${row.costUsd.toFixed(2)}`,
      '',
    ]),
    ...report.topTools.map((row) => ['tool', row.name, String(row.calls), '', '']),
  ];
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
