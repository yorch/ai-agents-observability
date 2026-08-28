import { NextResponse } from 'next/server';
import { type ReportDigest, reportCsv, reportMarkdown } from './reporting';

export function reportDays(raw: string | null): 7 | 30 | 90 {
  if (raw === '7') {
    return 7;
  }
  if (raw === '90') {
    return 90;
  }
  return 30;
}

export function reportResponse(report: ReportDigest, rawFormat: string | null): NextResponse {
  const format = rawFormat === 'md' || rawFormat === 'csv' ? rawFormat : 'json';
  if (format === 'md') {
    return new NextResponse(reportMarkdown(report), {
      headers: {
        'Content-Disposition': 'attachment; filename="agent-digest.md"',
        'Content-Type': 'text/markdown; charset=utf-8',
      },
    });
  }
  if (format === 'csv') {
    return new NextResponse(reportCsv(report), {
      headers: {
        'Content-Disposition': 'attachment; filename="agent-digest.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
      },
    });
  }
  return NextResponse.json(report, {
    headers: { 'Content-Disposition': 'attachment; filename="agent-digest.json"' },
  });
}
