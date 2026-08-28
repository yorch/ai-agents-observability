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

export type ReportBundle = {
  manifest: {
    generatedAt: string;
    period: ReportDigest['period'];
    scope: ReportDigest['scope'];
    schemaVersion: 1;
    visibility: {
      includesMemberLevelData: false;
      includesTranscripts: false;
      policy: 'self-aggregate' | 'team-aggregate' | 'org-aggregate';
    };
  };
  files: {
    content: string;
    mediaType: 'text/csv' | 'text/html' | 'text/markdown' | 'application/json';
    path: 'report.csv' | 'report.html' | 'report.json' | 'report.md';
  }[];
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

function htmlCell(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A self-contained, escaped HTML snapshot for sharing a report outside the app. */
export function reportHtml(report: ReportDigest): string {
  const metricRows = report.metrics
    .map(
      (metric) =>
        `<tr><th scope="row">${htmlCell(metric.label)}</th><td>${htmlCell(formatValue(metric.current, metric.unit))}</td><td>${htmlCell(formatValue(metric.prior, metric.unit))}</td><td>${htmlCell(formatReportDelta(metric))}</td></tr>`,
    )
    .join('');
  const modelRows = report.topModels
    .map(
      (row) =>
        `<tr><th scope="row">${htmlCell(row.model)}</th><td>${row.sessions.toLocaleString()}</td><td>$${row.costUsd.toFixed(2)}</td></tr>`,
    )
    .join('');
  const toolRows = report.topTools
    .map(
      (row) =>
        `<tr><th scope="row">${htmlCell(row.name)}</th><td>${row.calls.toLocaleString()}</td></tr>`,
    )
    .join('');
  const notes = report.notes.map((note) => `<li>${htmlCell(note)}</li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlCell(report.scope.label)} agent digest</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.5;max-width:900px;margin:2rem auto;padding:0 1rem;color:#17202a}table{border-collapse:collapse;width:100%;margin:1rem 0 2rem}th,td{border:1px solid #ccd3d9;padding:.5rem;text-align:left}td{text-align:right}th[scope=row]{font-weight:500;text-align:left}caption{text-align:left;font-size:1.2rem;font-weight:700;margin-bottom:.5rem}</style></head>
<body><main><h1>${htmlCell(report.scope.label)} agent digest</h1><p>Trailing ${report.period.days}-day period: ${htmlCell(report.period.start)} to ${htmlCell(report.period.end)}. Generated ${htmlCell(report.generatedAt)}.</p>
<table><caption>Summary</caption><thead><tr><th>Metric</th><th>This period</th><th>Prior</th><th>Change</th></tr></thead><tbody>${metricRows}</tbody></table>
${modelRows ? `<table><caption>Top models</caption><thead><tr><th>Model</th><th>Sessions</th><th>Cost</th></tr></thead><tbody>${modelRows}</tbody></table>` : ''}
${toolRows ? `<table><caption>Top tools</caption><thead><tr><th>Tool</th><th>Calls</th></tr></thead><tbody>${toolRows}</tbody></table>` : ''}
${notes ? `<section><h2>Notes</h2><ul>${notes}</ul></section>` : ''}</main></body></html>\n`;
}

/**
 * A portable aggregate-only bundle. It intentionally uses JSON as the
 * container so it remains dependency-free and inspectable on every platform.
 */
export function reportBundle(report: ReportDigest): ReportBundle {
  const policy: ReportBundle['manifest']['visibility']['policy'] =
    report.scope.type === 'me' ? 'self-aggregate' : `${report.scope.type}-aggregate`;
  return {
    files: [
      {
        content: JSON.stringify(report, null, 2),
        mediaType: 'application/json',
        path: 'report.json',
      },
      { content: reportMarkdown(report), mediaType: 'text/markdown', path: 'report.md' },
      { content: reportCsv(report), mediaType: 'text/csv', path: 'report.csv' },
      { content: reportHtml(report), mediaType: 'text/html', path: 'report.html' },
    ],
    manifest: {
      generatedAt: report.generatedAt,
      period: report.period,
      schemaVersion: 1,
      scope: report.scope,
      visibility: { includesMemberLevelData: false, includesTranscripts: false, policy },
    },
  };
}
